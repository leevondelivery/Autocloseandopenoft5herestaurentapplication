require('dotenv').config();
const mongoose = require('mongoose');

async function listDatabases() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const adminDb = mongoose.connection.db.admin();
    const dbs = await adminDb.listDatabases();
    console.log('Databases in cluster:', dbs.databases.map(d => d.name));

    for (const dbInfo of dbs.databases) {
      if (['admin', 'local'].includes(dbInfo.name)) continue;
      const conn = mongoose.connection.useDb(dbInfo.name);
      const doc = await conn.collection('restuarentusers').findOne({ name: /talimpu/i });
      if (doc) {
        console.log(`FOUND TALIMPU IN DB [${dbInfo.name}]:`, JSON.stringify(doc, null, 2));
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

listDatabases();
