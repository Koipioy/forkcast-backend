'use strict';

/**
 * Minimal in-memory Firestore stand-in for the recipe-import tests.
 *
 * Mirrors just enough of the real API - collection/doc/get/set/update/where and
 * runTransaction - for jobStore and the worker to be exercised without an
 * emulator. Writes are recorded so a test can assert what actually landed.
 */

function applyValue(current, value) {
  if (value && typeof value === 'object' && value.__op === 'increment') {
    return Number(current || 0) + Number(value.value);
  }
  return value;
}

function makeFakeFirestore() {
  const store = new Map();
  const writes = [];

  function mapFor(collectionName) {
    if (!store.has(collectionName)) store.set(collectionName, new Map());
    return store.get(collectionName);
  }

  function docRef(collectionName, id) {
    const map = mapFor(collectionName);
    return {
      id,
      path: `${collectionName}/${id}`,
      async get() {
        const exists = map.has(id);
        return {
          exists,
          data: () => (exists ? structuredClone(map.get(id)) : undefined),
        };
      },
      async set(data, opts = {}) {
        const existing = opts.merge ? map.get(id) || {} : {};
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        map.set(id, next);
        writes.push({ op: 'set', path: `${collectionName}/${id}` });
      },
      async update(data) {
        if (!map.has(id)) {
          throw new Error(`Document does not exist: ${collectionName}/${id}`);
        }
        const existing = map.get(id);
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        map.set(id, next);
        writes.push({ op: 'update', path: `${collectionName}/${id}` });
      },
      async delete() {
        map.delete(id);
        writes.push({ op: 'delete', path: `${collectionName}/${id}` });
      },
    };
  }

  const db = {
    collection(name) {
      return {
        doc(id) {
          return docRef(name, id);
        },
        async add(data) {
          const id = `auto_${mapFor(name).size + 1}`;
          await docRef(name, id).set(data);
          return { id };
        },
        where(field, op, value) {
          const filter = ([, data]) => {
            const actual = data ? data[field] : undefined;
            if (op === '<=') return Number(actual) <= Number(value);
            if (op === '>=') return Number(actual) >= Number(value);
            if (op === '==') return actual === value;
            return true;
          };
          return {
            limit(n) {
              return {
                async get() {
                  const map = mapFor(name);
                  const docs = Array.from(map.entries())
                    .filter(filter)
                    .slice(0, n)
                    .map(([id, data]) => ({
                      id,
                      data: () => structuredClone(data),
                      ref: docRef(name, id),
                    }));
                  return { docs, size: docs.length, empty: docs.length === 0 };
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      // A Firestore transaction acts on document references, not on the db.
      const tx = Object.create(db);
      tx.update = async (ref, data) => ref.update(data);
      tx.set = async (ref, data, opts) => ref.set(data, opts);
      tx.get = async (ref) => ref.get();
      return fn(tx);
    },
    __store: store,
    __writes: writes,
    __dump(name) {
      return structuredClone(Object.fromEntries(mapFor(name)));
    },
  };

  return db;
}

module.exports = { makeFakeFirestore };
