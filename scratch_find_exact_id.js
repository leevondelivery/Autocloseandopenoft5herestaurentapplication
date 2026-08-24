require('dotenv').config();
const mongoose = require('mongoose');

async function findExactId() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const adminDb = mongoose.connection.db.admin();
    const dbs = await adminDb.listDatabases();

    for (const dbInfo of dbs.databases) {
      if (['admin', 'local', 'config'].includes(dbInfo.name)) continue;
      const connDb = mongoose.connection.useDb(dbInfo.name);
      const collections = await connDb.db.listCollections().toArray();

      for (const col of collections) {
        const docs = await connDb.db.collection(col.name).find({}).toArray();
        for (const d of docs) {
          const str = JSON.stringify(d);
          if (str.includes('6a53f0054d3122175ec41f6c') || str.toLowerCase().includes('talimpu')) {
            console.log(`\n🎉 FOUND IN DB [${dbInfo.name}] -> COLLECTION [${col.name}]:`);
            console.log(JSON.stringify(d, null, 2));
          }
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

findExactId();
