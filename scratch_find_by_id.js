require('dotenv').config();
const mongoose = require('mongoose');

async function findById() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;

    console.log('--- Search by _id: 6a53f0054d3122175ec41f6c ---');
    const docById = await db.collection('restuarentusers').findOne({ _id: new mongoose.Types.ObjectId('6a53f0054d3122175ec41f6c') });
    console.log('docById:', JSON.stringify(docById, null, 2));

    console.log('--- Search by restId: "1" ---');
    const docsRestId1 = await db.collection('restuarentusers').find({ restId: "1" }).toArray();
    console.log('docsRestId1:', JSON.stringify(docsRestId1, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

findById();
