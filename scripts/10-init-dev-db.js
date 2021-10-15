conn = new Mongo();

sessDb = conn.getDB('testdb');
sessDb.auth('nptest', 'nptest');
sessDb.createUser({
    user: 'nptest',
    pwd: 'nptest',
    roles: [{ role: 'readWrite', db: 'testdb' }],
});

db = conn.getDB('testdb');
db.auth('nptest', 'nptest');
db.createUser({ user: 'nptest', pwd: 'nptest', roles: [{ role: 'readWrite', db: 'testdb' }] });
