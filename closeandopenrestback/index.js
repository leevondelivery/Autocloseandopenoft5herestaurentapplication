require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');

// Check for MongoDB URI (Production cluster has 23 restaurants)
const PROD_MONGODB_URI = 'mongodb+srv://leevondelivery_db_user:Leevon2026@cluster0.0jp6bhd.mongodb.net/?appName=Cluster0';

let rawUri = (process.env.MONGODB_URI || '').trim().replace(/^["']|["']$/g, '');
let MONGODB_URI = rawUri;

// If URI is missing, has an invalid scheme, or points to the old 7-restaurant cluster, use primary production URI
if (
  !MONGODB_URI ||
  (!MONGODB_URI.startsWith('mongodb://') && !MONGODB_URI.startsWith('mongodb+srv://')) ||
  MONGODB_URI.includes('nbhpjuy')
) {
  console.log('Connecting to primary production cluster with all 23 restaurants (cluster0.0jp6bhd)...');
  MONGODB_URI = PROD_MONGODB_URI;
}



// 1. Define Mongoose Schemas & Models
const restaurantUserSchema = new mongoose.Schema({
  restId: { type: String, required: true },
  name: { type: String },
  openTime: { type: String, required: true },
  closeTime: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  isManuallyToggled: { type: Boolean, default: false },
  manualStatusUpdatedAt: { type: Date },
  lastScheduledShift: { type: String },
  lastScheduledAt: { type: Date }
}, { collection: 'restuarentusers', strict: false });

const RestaurantUser = mongoose.model('RestaurantUser', restaurantUserSchema);

// 2. High-Precision IST Time Helpers
const istFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function getISTTimeAndDate() {
  const now = new Date();
  const parts = istFormatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type)?.value;
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const h = parseInt(getPart('hour'), 10) % 24;
  const m = parseInt(getPart('minute'), 10);
  const s = parseInt(getPart('second'), 10);
  const dateStr = `${year}-${month}-${day}`;
  const timeString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const timeStringWithSec = `${timeString}:${String(s).padStart(2, '0')}`;
  const currentMins = h * 60 + m;

  return {
    dateStr,
    timeString,
    timeStringWithSec,
    currentMins,
    seconds: s,
    isoIST: `${dateStr}T${timeStringWithSec}+05:30`
  };
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const str = timeStr.trim().toUpperCase();

  // 12-hour format with AM/PM (with or without seconds, e.g. "11:30 AM", "04:00:00 PM", "9:00PM")
  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = parseInt(ampmMatch[2], 10);
    const ampm = ampmMatch[3];
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }


  const match24 = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }

  return null;
}

function isOpen(currentMins, openTimeStr, closeTimeStr) {
  const openMins = parseTimeToMinutes(openTimeStr);
  const closeMins = parseTimeToMinutes(closeTimeStr);

  if (openMins === null || closeMins === null) {
    return false;
  }

  // If open and close times are identical, treat as 24h open
  if (openMins === closeMins) return true;

  if (openMins < closeMins) {
    // Standard daytime shift (e.g. 11:00 to 22:00)
    // Open from openMins up to closeMins - 1 (closes the exact second closeMins begins)
    return currentMins >= openMins && currentMins < closeMins;
  } else {
    // Overnight shift spanning midnight (e.g. 18:00 to 04:00)
    return currentMins >= openMins || currentMins < closeMins;
  }
}

function getShiftKey(istDateStr, currentMins, openTimeStr, closeTimeStr) {
  const openMins = parseTimeToMinutes(openTimeStr);
  const closeMins = parseTimeToMinutes(closeTimeStr);
  if (openMins === null || closeMins === null) return 'unknown';

  const currentlyOpen = isOpen(currentMins, openTimeStr, closeTimeStr);

  if (openMins < closeMins) {
    // Normal daytime shift (e.g. 11:00 to 22:00)
    if (currentlyOpen) {
      return `${istDateStr}_open_${openTimeStr}_to_${closeTimeStr}`;
    } else {
      if (currentMins < openMins) {
        return `${istDateStr}_preopen_${openTimeStr}_to_${closeTimeStr}`;
      } else {
        return `${istDateStr}_postclose_${openTimeStr}_to_${closeTimeStr}`;
      }
    }
  } else {
    // Overnight shift spanning midnight (e.g. 18:00 to 04:00)
    if (currentlyOpen) {
      if (currentMins >= openMins) {
        return `${istDateStr}_nightopen_${openTimeStr}_to_${closeTimeStr}`;
      } else {
        return `prev_nightopen_until_${istDateStr}_${closeTimeStr}`;
      }
    } else {
      return `${istDateStr}_nightclosed_${closeTimeStr}_to_${openTimeStr}`;
    }
  }
}

let lastRunStatus = {
  success: true,
  timestamp: null,
  message: 'Scheduler has not run yet.',
  updatedRestaurants: [],
  respectedManualOverrides: []
};

let isProcessing = false;
let lastLogMinute = -1;

async function checkAndUpdateRestaurantStatuses() {
  if (isProcessing) return lastRunStatus;
  isProcessing = true;

  try {
    const { dateStr, timeString: currentTimeIST, timeStringWithSec, currentMins } = getISTTimeAndDate();

    // Fetch live users directly from MongoDB
    const users = await RestaurantUser.find({}).lean();

    const bulkOps = [];
    const statusOps = [];
    const updated = [];
    const skippedManual = [];

    for (const user of users) {
      if (!user._id) continue;

      const openTime = user.openTime;
      const closeTime = user.closeTime;
      const currentActive = user.isActive;
      const isManuallyToggled = user.isManuallyToggled === true;
      const shouldBeActive = isOpen(currentMins, openTime, closeTime);
      const currentShiftKey = getShiftKey(dateStr, currentMins, openTime, closeTime);

      const isNewShiftTransition = user.lastScheduledShift !== currentShiftKey;

      if (isNewShiftTransition) {
        // A scheduled shift transition (openTime or closeTime) has occurred!
        // The schedule transition takes effect immediately and clears the manual toggle for the new shift.
        if (currentActive !== shouldBeActive || isManuallyToggled || !user.lastScheduledShift) {
          bulkOps.push({
            updateOne: {
              filter: { _id: user._id },
              update: {
                $set: {
                  isActive: shouldBeActive,
                  isManuallyToggled: false,
                  lastScheduledShift: currentShiftKey,
                  lastScheduledAt: new Date()
                }
              }
            }
          });

          const restIdentifier = String(user.restId || user.restaurantId || user._id);
          statusOps.push({
            updateOne: {
              filter: { $or: [{ restaurantId: restIdentifier }, { restId: restIdentifier }] },
              update: {
                $set: {
                  isActive: shouldBeActive,
                  isManuallyToggled: false,
                  manualStatusUpdatedAt: new Date()
                }
              }
            }
          });

          updated.push({
            restaurantId: restIdentifier,
            name: user.name || 'N/A',
            prevStatus: currentActive === undefined ? 'N/A' : currentActive,
            newStatus: shouldBeActive,
            reason: `Scheduled transition: ${shouldBeActive ? 'AUTO-OPEN' : 'AUTO-CLOSE'} (${currentShiftKey})`,
            openTime,
            closeTime
          });
        }
      } else {
        // We are within an ongoing shift window.
        if (isManuallyToggled) {
          // Restaurant owner manually toggled their status during this shift -> RESPECT IT!
          skippedManual.push({
            restaurantId: user.restId || user._id,
            name: user.name || 'N/A',
            status: currentActive,
            scheduledShouldBe: shouldBeActive,
            reason: 'Manual override active for current shift'
          });
        } else if (currentActive === undefined || currentActive !== shouldBeActive) {
          // No manual override, but status is out of sync with current operating hours -> sync it immediately
          bulkOps.push({
            updateOne: {
              filter: { _id: user._id },
              update: {
                $set: {
                  isActive: shouldBeActive,
                  lastScheduledShift: currentShiftKey,
                  lastScheduledAt: new Date()
                }
              }
            }
          });

          const restIdentifier = String(user.restId || user.restaurantId || user._id);
          statusOps.push({
            updateOne: {
              filter: { $or: [{ restaurantId: restIdentifier }, { restId: restIdentifier }] },
              update: {
                $set: {
                  isActive: shouldBeActive,
                  manualStatusUpdatedAt: new Date()
                }
              }
            }
          });

          updated.push({
            restaurantId: restIdentifier,
            name: user.name || 'N/A',
            prevStatus: currentActive === undefined ? 'N/A' : currentActive,
            newStatus: shouldBeActive,
            reason: `Synced to scheduled status (${shouldBeActive ? 'OPEN' : 'CLOSED'})`,
            openTime,
            closeTime
          });
        }
      }
    }

    if (bulkOps.length > 0) {
      console.log(`[${timeStringWithSec} IST] Found ${bulkOps.length} status transition(s) to apply immediately:`);
      updated.forEach(item => {
        console.log(` -> Restaurant ${item.name} (ID: ${item.restaurantId}): ${item.prevStatus} -> ${item.newStatus} [${item.reason}] (Open: ${item.openTime}, Close: ${item.closeTime})`);
      });

      await RestaurantUser.bulkWrite(bulkOps, { ordered: false });

      // Also keep restaurantstatuses collection in sync if present
      if (statusOps.length > 0) {
        try {
          await mongoose.connection.db.collection('restaurantstatuses').bulkWrite(statusOps, { ordered: false });
        } catch (e) {
          // Silently ignore if collection not present
        }
      }

      console.log(`[${timeStringWithSec} IST] Successfully updated ${bulkOps.length} restaurant status(es) in MongoDB.`);
    } else if (currentMins !== lastLogMinute) {
      // Log periodic status once per minute so logs stay clean
      lastLogMinute = currentMins;
      console.log(`[${timeStringWithSec} IST] Heartbeat: all ${users.length} restaurant statuses are verified and up to date.`);
    }

    lastRunStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      currentTimeIST,
      timeStringWithSec,
      dateIST: dateStr,
      message: `Processed ${users.length} restaurants. Applied ${bulkOps.length} updates. Respected ${skippedManual.length} manual overrides.`,
      updatedRestaurants: updated,
      respectedManualOverrides: skippedManual
    };

    return lastRunStatus;
  } catch (error) {
    console.error('Error updating restaurant statuses:', error);
    lastRunStatus = {
      success: false,
      timestamp: new Date().toISOString(),
      message: `Error: ${error.message}`,
      updatedRestaurants: [],
      respectedManualOverrides: []
    };
    return lastRunStatus;
  } finally {
    isProcessing = false;
  }
}

// 3. Connect to MongoDB and Start 1-Second Real-Time Scheduler
const CHECK_INTERVAL_MS = 1000; // Check EVERY 1 SECOND for zero-delay instant open/close!

console.log('Connecting to MongoDB...');
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully!');

    // Run initial check immediately on boot
    checkAndUpdateRestaurantStatuses();

    // Start 1-second high-precision interval for instant transitions (ZERO delay!)
    setInterval(() => {
      checkAndUpdateRestaurantStatuses();
    }, CHECK_INTERVAL_MS);

    console.log(`High-precision real-time scheduler active! Checking every ${CHECK_INTERVAL_MS / 1000}s for instant zero-delay transitions.`);
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });

// 4. HTTP Health Check & Manual Trigger Endpoints
const PORT = process.env.PORT || 3088;
const HOST = process.env.HOST || '0.0.0.0';
const RAILWAY_INTERNAL_URL = process.env.RAILWAY_INTERNAL_URL || 'http://autocloseandopenoft5herestaurentapplication.railway.internal';

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      time: new Date().toISOString(),
      railwayInternalUrl: RAILWAY_INTERNAL_URL,
      checkFrequency: '1 second (real-time)',
      scheduler: lastRunStatus
    }, null, 2));
  } else if (req.url === '/run-now' || req.url === '/trigger') {
    const runResult = await checkAndUpdateRestaurantStatuses();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      triggered: true,
      result: runResult
    }, null, 2));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`Port ${PORT} is in use, retrying on a random free port...`);
    server.listen(0, HOST);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'string' ? address : address.port;
  console.log(`Health check server listening on http://${HOST}:${actualPort}`);
  console.log(`Railway Internal Domain: ${RAILWAY_INTERNAL_URL}`);
});

module.exports = {
  parseTimeToMinutes,
  isOpen,
  getShiftKey,
  getISTTimeAndDate,
  checkAndUpdateRestaurantStatuses
};
