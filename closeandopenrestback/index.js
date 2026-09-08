require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const cron = require('node-cron');

// Check for MongoDB URI
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI is not defined in the .env file.');
  process.exit(1);
}

// 1. Define Mongoose Schemas & Models
// Using collection 'restuarentusers' as structured in the DB
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

// 2. Time Helper Functions
function getISTTimeAndDate() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type)?.value;
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const h = parseInt(getPart('hour'), 10) % 24;
  const m = parseInt(getPart('minute'), 10);
  const s = parseInt(getPart('second'), 10);
  const dateStr = `${year}-${month}-${day}`;
  const timeString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const currentMins = h * 60 + m;

  return {
    dateStr,
    timeString,
    currentMins,
    seconds: s,
    isoIST: `${dateStr}T${timeString}:${String(s).padStart(2, '0')}+05:30`
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

  // 24-hour format (with or without seconds, e.g. "11:30", "09:00", "9:00", "22:00:00")
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
      return `${istDateStr}_open_${openTimeStr}`;
    } else {
      if (currentMins < openMins) {
        return `${istDateStr}_closed_pre_open`;
      } else {
        return `${istDateStr}_closed_post_close`;
      }
    }
  } else {
    // Overnight shift spanning midnight (e.g. 18:00 to 04:00)
    if (currentlyOpen) {
      if (currentMins >= openMins) {
        return `${istDateStr}_open_night_${openTimeStr}`;
      } else {
        return `prev_open_night_until_${istDateStr}_${closeTimeStr}`;
      }
    } else {
      return `${istDateStr}_closed_day_${closeTimeStr}_to_${openTimeStr}`;
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

async function checkAndUpdateRestaurantStatuses() {
  const { dateStr, timeString: currentTimeIST, currentMins } = getISTTimeAndDate();
  console.log(`[${new Date().toISOString()}] Running scheduler check. Current Time (IST): ${currentTimeIST} (${dateStr})`);

  try {
    const users = await RestaurantUser.find({}).lean();

    const bulkOps = [];
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
        // The schedule transition takes effect and clears the manual toggle for the new shift.
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

          updated.push({
            restaurantId: user.restId || user._id,
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
          // No manual override, but status is out of sync with current operating hours -> sync it
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

          updated.push({
            restaurantId: user.restId || user._id,
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
      console.log(`Found ${bulkOps.length} status changes to apply:`);
      updated.forEach(item => {
        console.log(` - Restaurant ${item.name} (ID: ${item.restaurantId}): ${item.prevStatus} -> ${item.newStatus} [${item.reason}] (Open: ${item.openTime}, Close: ${item.closeTime})`);
      });

      await RestaurantUser.bulkWrite(bulkOps, { ordered: false });
      console.log('Successfully updated restaurant statuses in restuarentusers collection.');
    } else {
      console.log('All restaurant statuses are already up to date.');
    }

    if (skippedManual.length > 0) {
      console.log(`Respected ${skippedManual.length} manual restaurant overrides:`);
      skippedManual.forEach(item => {
        console.log(` - Restaurant ${item.name} (ID: ${item.restaurantId}): kept ${item.status ? 'ONLINE' : 'OFFLINE'} (scheduled would be ${item.scheduledShouldBe ? 'OPEN' : 'CLOSED'})`);
      });
    }

    lastRunStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      currentTimeIST,
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
      currentTimeIST,
      message: `Error: ${error.message}`,
      updatedRestaurants: [],
      respectedManualOverrides: []
    };
    return lastRunStatus;
  }
}

console.log('Connecting to MongoDB...');
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully!');

    checkAndUpdateRestaurantStatuses();

    cron.schedule('* * * * *', () => {
      checkAndUpdateRestaurantStatuses();
    });
    console.log('Scheduler loaded successfully. Status check scheduled for every minute (* * * * *).');
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });

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
