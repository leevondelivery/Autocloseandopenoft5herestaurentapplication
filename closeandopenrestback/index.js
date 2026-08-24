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
function getCurrentTimeInIST() {
  const options = {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  // 'en-GB' format returns HH:MM in 24-hour style
  const formatter = new Intl.DateTimeFormat('en-GB', options);
  return formatter.format(new Date());
}

function isOpen(currentTime, openTime, closeTime) {
  if (!openTime || !closeTime) return false;
  
  // If open and close times are the same, treat as open 24h/always open (as currently seen in DB)
  if (openTime === closeTime) return true;

  if (openTime < closeTime) {
    // Normal day shift (e.g. 09:00 to 22:00)
    return currentTime >= openTime && currentTime < closeTime;
  } else {
    // Night shift spanning midnight (e.g. 18:00 to 02:00)
    return currentTime >= openTime || currentTime < closeTime;
  }
}

// 3. Status Updater Logic
let lastRunStatus = {
  success: true,
  timestamp: null,
  message: 'Scheduler has not run yet.',
  updatedRestaurants: []
};

async function checkAndUpdateRestaurantStatuses() {
  const currentTime = getCurrentTimeInIST();
  console.log(`[${new Date().toISOString()}] Running scheduler check. Current Time (IST): ${currentTime}`);
  
  try {
    const users = await RestaurantUser.find({}, { restId: 1, openTime: 1, closeTime: 1, isActive: 1 }).lean();

    const bulkOps = [];
    const updated = [];

    for (const user of users) {
      if (!user.restId) continue;

      const shouldBeActive = isOpen(currentTime, user.openTime, user.closeTime);
      const currentActive = user.isActive;

      // Only perform update if status is different or record doesn't exist
      if (currentActive === undefined || currentActive !== shouldBeActive) {
        bulkOps.push({
          updateOne: {
            filter: { _id: user._id },
            update: { 
              $set: { 
                isActive: shouldBeActive
              } 
            }
          }
        });

        updated.push({
          restaurantId: user.restId,
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
        console.log(` - Restaurant ${item.restaurantId}: ${item.prevStatus} -> ${item.newStatus} (Open: ${item.openTime}, Close: ${item.closeTime})`);
      });

      await RestaurantUser.bulkWrite(bulkOps);
      console.log('Successfully updated restaurant statuses in restuarentusers collection.');
    } else {
      console.log('All restaurant statuses are already up to date.');
    }

    lastRunStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      currentTimeIST: currentTime,
      message: `Processed ${users.length} restaurants. Applied ${bulkOps.length} updates.`,
      updatedRestaurants: updated
    };

  } catch (error) {
    console.error('Error updating restaurant statuses:', error);
    lastRunStatus = {
      success: false,
      timestamp: new Date().toISOString(),
      currentTimeIST: currentTime,
      message: `Error: ${error.message}`,
      updatedRestaurants: []
    };
  }
}


console.log('Connecting to MongoDB...');
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB successfully!');
    
    // Run status check immediately on startup
    checkAndUpdateRestaurantStatuses();

    // Schedule status check to run every minute
    cron.schedule('* * * * *', () => {
      checkAndUpdateRestaurantStatuses();
    });
    console.log('Scheduler loaded successfully. Status check scheduled for every minute (* * * * *).');
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });

// 5. Lightweight HTTP Server for Health Checks
const PORT = process.env.PORT || 3088;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      time: new Date().toISOString(),
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
    server.listen(0);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, () => {
  const address = server.address();
  const actualPort = typeof address === 'string' ? address : address.port;
  console.log(`Health check server listening on port ${actualPort}`);
});
