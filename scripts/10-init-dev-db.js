/* global Mongo */
const conn = new Mongo();

const db = conn.getDB('testdb');
db.createUser({ user: 'nptest', pwd: 'nptest', roles: [{ role: 'readWrite', db: 'testdb' }] });
