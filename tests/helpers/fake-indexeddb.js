// A minimal in-memory IndexedDB stub covering exactly the surface the offline
// tile store uses: open with upgrade (createObjectStore + createIndex),
// put/get/getAll/delete, index cursors with range-only iteration, cursor
// delete, and transaction completion. Requests settle on the microtask queue,
// so `await requestToPromise(...)` and `transactionDone(tx)` behave like the
// real thing.
'use strict';

function settle(fn, ...args) {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      fn(...args);
      resolve();
    });
  });
}

class FakeRequest {
  constructor(getResult) {
    this._getResult = getResult;
    this.onsuccess = null;
    this.onerror = null;
    this.error = null;
    this.result = undefined;
    settle(() => {
      try {
        this.result = this._getResult();
      } catch (err) {
        this.error = err;
        if (this.onerror) this.onerror();
        return;
      }
      if (this.onsuccess) this.onsuccess();
    });
  }
}

class FakeCursorRequest {
  constructor(backing, matches) {
    this._backing = backing; // the store's live record array
    this._matches = matches;
    this._pos = 0;
    this._deletedCurrent = false;
    this.onsuccess = null;
    this.onerror = null;
    this.result = null;
    settle(() => this._advance());
  }

  _advance() {
    const visible = this._backing.filter(this._matches);
    if (this._pos >= visible.length) {
      this.result = null;
    } else {
      const value = visible[this._pos];
      const request = this;
      this.result = {
        value,
        delete() {
          const at = request._backing.indexOf(value);
          if (at >= 0) request._backing.splice(at, 1);
          request._deletedCurrent = true;
        },
        continue: () => {
          if (!request._deletedCurrent) request._pos += 1;
          request._deletedCurrent = false;
          queueMicrotask(() => request._advance());
        },
      };
    }
    if (this.onsuccess) this.onsuccess();
  }
}

class FakeObjectStore {
  constructor(records, keyPath, indexes) {
    this._records = records;
    this._keyPath = keyPath;
    this._indexes = indexes; // Map<indexName, property>, shared with the db entry
  }

  createIndex(name, property) {
    this._indexes.set(name, property);
    return this;
  }

  index(name) {
    const property = this._indexes.get(name);
    if (!property) throw new Error(`no index named ${name}`);
    const store = this;
    return {
      openCursor(range) {
        const wanted = range && range.__only;
        return new FakeCursorRequest(store._records, (r) => wanted === undefined || r[property] === wanted);
      },
    };
  }

  put(value) {
    const store = this;
    return new FakeRequest(() => {
      const key = value[store._keyPath];
      const at = store._records.findIndex((r) => r[store._keyPath] === key);
      if (at >= 0) store._records[at] = { ...value };
      else store._records.push({ ...value });
      return value;
    });
  }

  get(key) {
    const store = this;
    return new FakeRequest(() => {
      const hit = store._records.find((r) => r[store._keyPath] === key);
      return hit ? { ...hit } : undefined;
    });
  }

  getAll() {
    const store = this;
    return new FakeRequest(() => store._records.map((r) => ({ ...r })));
  }

  delete(key) {
    const store = this;
    return new FakeRequest(() => {
      const at = store._records.findIndex((r) => r[store._keyPath] === key);
      if (at >= 0) store._records.splice(at, 1);
      return undefined;
    });
  }
}

class FakeDatabase {
  constructor(entry) {
    this._entry = entry; // { name, version, stores: Map<name, records[]> }
    this.objectStoreNames = {
      contains: (name) => this._entry.stores.has(name),
    };
  }

  createObjectStore(name, { keyPath } = {}) {
    this._entry.stores.set(name, []);
    this._entry.keyPaths.set(name, keyPath);
    this._entry.indexes.set(name, new Map());
    return new FakeObjectStore(this._entry.stores.get(name), keyPath, this._entry.indexes.get(name));
  }

  transaction() {
    const entry = this._entry;
    const tx = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(name) {
        const records = entry.stores.get(name);
        if (!records) throw new Error(`no object store named ${name}`);
        // Records, keyPath and indexes all live on the db entry, shared with
        // the object store created during upgrade.
        const keyPath = entry.keyPaths.get(name);
        const indexes = entry.indexes.get(name);
        return new FakeObjectStore(records, keyPath, indexes);
      },
    };
    // Complete on a macrotask: every request (and cursor tick) settles on
    // the microtask queue, so by the time this runs all work is done — the
    // real transaction's oncomplete never races its own requests either.
    setTimeout(() => {
      if (tx.oncomplete) tx.oncomplete();
    }, 0);
    return tx;
  }

  close() {}
}

function createFakeIndexedDB() {
  const databases = new Map(); // name -> { version, stores, keyPaths }

  function open(name, version) {
    let entry = databases.get(name);
    const upgrade = !entry || entry.version !== version;
    if (!entry) {
      entry = { name, version, stores: new Map(), keyPaths: new Map(), indexes: new Map() };
      databases.set(name, entry);
    }
    const request = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      error: null,
      result: undefined,
    };
    queueMicrotask(() => {
      request.result = new FakeDatabase(entry);
      if (upgrade && request.onupgradeneeded) request.onupgradeneeded();
      if (request.onsuccess) request.onsuccess();
    });
    return request;
  }

  return { open };
}

module.exports = { createFakeIndexedDB };