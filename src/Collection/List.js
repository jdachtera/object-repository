export class List {
  array = null;

  constructor() {
    this.array = new Array();
    this.addArray(arguments);
  }

  onAdd(item) {}

  onRemove(item) {}

  add(item) {
    const index = this.array.indexOf(item);
    if (index === -1) {
      this.array.push(item);
      this.onAdd(item);
    }
    return this;
  }

  remove(item) {
    var index = this.array.indexOf(item);
    if (index !== -1) {
      this.splice(index, index);
      this.onRemove(item);
    }
  }

  addArray(inArray) {
    for (const item of inArray) {
      this.add(item);
    }
    return this;
  }

  clear() {
    this.array.length = 0;
  }

  get(index) {
    return this.array[index];
  }

  map(callback) {
    return this.array.map(callback);
  }

  toArray() {
    return this.array.slice();
  }
}
