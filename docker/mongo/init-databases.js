/**
 * Inicializa las 4 bases de datos lógicas de Lumia en un solo cluster MongoDB.
 */
const dbs = ['identity_db', 'catalog_db', 'sales_db', 'production_db']

dbs.forEach(function (name) {
  const database = db.getSiblingDB(name)
  if (!database.getCollectionNames().includes('_init')) {
    database.createCollection('_init')
  }
  print('Initialized database: ' + name)
})

print('Lumia MongoDB databases ready.')
