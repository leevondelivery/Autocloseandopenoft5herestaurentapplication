require('dotenv').config();
const mongoose = require('mongoose');

async function findTalimpuInDbs() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const adminDb = mongoose.connection.db.admin();
    const dbs = await adminDb.listDatabases();

    for (const dbInfo of dbs.databases) {
      if (['admin', 'local', 'config'].includes(dbInfo.name)) continue;
      const connDb = mongoose.connection.useDb(dbInfo.name);
      const collections = await connDb.db.listCollections().toArray();

      for (const col of collections) {
        const doc = await connDb.db.collection(col.name).findOne({
          $or: [
            { _id: new mongoose.Types.ObjectId('6a53f0054d3122175ec41f6c') },
            { name: /talimpu/i }
          ]
        });
        if (doc) {
          console.log(`\n🎉 FOUND IN DATABASE [${dbInfo.name}], COLLECTION [${col.name}]:`);
          console.log(JSON.stringify(doc, null, 2));
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

findTalimpuInDbs();
