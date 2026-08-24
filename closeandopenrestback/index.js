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
  openTime: { type: String, required: true }, // Format: "HH:MM"
  closeTime: { type: String, required: true }, // Format: "HH:MM"
  isActive: { type: Boolean, default: false }
}, { collection: 'restuarentusers' });

const RestaurantUser = mongoose.model('RestaurantUser', restaurantUserSchema);

// 2. Time Helper Functions
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  
  const str = timeStr.trim().toUpperCase();
  
  // 12-hour format with AM/PM (e.g. "11:30 AM", "9:00PM", "06:00 PM")
  const ampmMatch = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = parseInt(ampmMatch[2], 10);
    const ampm = ampmMatch[3];
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  // 24-hour format (e.g. "11:30", "09:00", "9:00", "22:00")
  const match24 = str.match(/^(\d{1,2}):(\d{2})/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }

  return null;
}

function getCurrentISTMinutes() {
  const now = new Date();
  // IST is UTC + 5:30 (+330 minutes)
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMins = (utcMins + 330) % 1440;
  const h = Math.floor(istMins / 60);
  const m = istMins % 60;
  const timeString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return {
    timeString,
    minutes: istMins
  };
}

function isOpen(currentMins, openTimeStr, closeTimeStr) {
  const openMins = parseTimeToMinutes(openTimeStr);
  const closeMins = parseTimeToMinutes(closeTimeStr);

  if (openMins === null || closeMins === null) {
    return false;
  }

  // If open and close times are the same, treat as open 24h/always open
  if (openMins === closeMins) return true;

  if (openMins < closeMins) {
    return currentMins >= openMins && currentMins < closeMins;
  } else {
    // Night shift spanning midnight (e.g. 18:00 to 04:00)
    return currentMins >= openMins || currentMins < closeMins;
  }
}

let lastRunStatus = {
  success: true,
  timestamp: null,
  message: 'Scheduler has not run yet.',
  updatedRestaurants: []
};

async function checkAndUpdateRestaurantStatuses() {
  const { timeString: currentTimeIST, minutes: currentMins } = getCurrentISTMinutes();
  console.log(`[${new Date().toISOString()}] Running scheduler check. Current Time (IST): ${currentTimeIST}`);
  
  try {
    const users = await RestaurantUser.find({}).lean();

    const bulkOps = [];
    const updated = [];

    for (const user of users) {
      if (!user._id) continue;

      const shouldBeActive = isOpen(currentMins, user.openTime, user.closeTime);
      const currentActive = user.isActive;

      if (currentActive === undefined || currentActive !== shouldBeActive) {
        bulkOps.push({
          updateOne: {
            filter: { _id: user._id },
            update: { 
              $set: { 
                isActive: shouldBeActive,
                manualStatusUpdatedAt: new Date()
              } 
            }
          }
        });

        updated.push({
          restaurantId: user.restId || user._id,
          name: user.name || 'N/A',
          prevStatus: currentActive === undefined ? 'N/A' : currentActive,
          newStatus: shouldBeActive,
          openTime: user.openTime,
          closeTime: user.closeTime
        });
      }
    }

    if (bulkOps.length > 0) {
      console.log(`Found ${bulkOps.length} status changes to apply:`);
      updated.forEach(item => {
        console.log(` - Restaurant ${item.name} (ID: ${item.restaurantId}): ${item.prevStatus} -> ${item.newStatus} (Open: ${item.openTime}, Close: ${item.closeTime})`);
      });

      await RestaurantUser.bulkWrite(bulkOps, { ordered: false });
      console.log('Successfully updated restaurant statuses in restuarentusers collection.');
    } else {
      console.log('All restaurant statuses are already up to date.');
    }

    lastRunStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      currentTimeIST,
      message: `Processed ${users.length} restaurants. Applied ${bulkOps.length} updates.`,
      updatedRestaurants: updated
    };

  } catch (error) {
    console.error('Error updating restaurant statuses:', error);
    lastRunStatus = {
      success: false,
      timestamp: new Date().toISOString(),
      currentTimeIST,
      message: `Error: ${error.message}`,
      updatedRestaurants: []
    };
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

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      time: new Date().toISOString(),
      railwayInternalUrl: RAILWAY_INTERNAL_URL,
      scheduler: lastRunStatus
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

