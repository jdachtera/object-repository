export const flatten = function(inArray) {
  var newArray = [];
  inArray.forEach(part => (newArray = newArray.concat(part)));
  return newArray;
};

export const unique = function(inArray, mapper) {
  var obj = {},
    newArray = [];
  mapper =
    mapper ||
    function(item) {
      return item;
    };
  inArray.forEach(item => {
    var hash = mapper(item);
    if (!obj[hash]) {
      obj[hash] = true;
      newArray.push(item);
    }
  });

  return newArray;
};

export const intersect = function(inArray1, inArray2) {
  var intersection = [];
  inArray1.forEach(item => {
    if (inArray2.indexOf(item) !== -1) {
      intersection.push(item);
    }
  });
  return intersection;
};

export const subtract = function(inMinuendArray, inSubtrahendArray) {
  if (!inMinuendArray.length || !inSubtrahendArray.length) {
    return inMinuendArray;
  }

  return inMinuendArray.filter(item => inSubtrahendArray.indexOf(item) === -1);
};

export const union = function(inArray1, inArray2) {
  return inArray1.concat(subtract(inArray2, inArray1));
};

export const reduce = function(inArray, inStartValue, inCallback) {
  inArray.forEach(item => (inStartValue = inCallback([inStartValue, item])));
  return inStartValue;
};

export const group = function(inArray, inIteratorCallback) {
  var groups = {};
  inArray.forEach((item, key) => {
    var groupName = inIteratorCallback(item, key);
    if (!groups.hashOwnProperty(groupName)) {
      groups[groupName] = [];
    }
    groups[groupName].push(item);
  });
  return groups;
};

export const domStringListToArray = function(inDOMStringList) {
  var array = [];
  for (var i = 0; i < inDOMStringList.length; i++) {
    array.push(inDOMStringList.item(i));
  }
  return array;
};

export const getHashMapKeys = function(inHashMap) {
  var keys = [];
  for (var k in inHashMap) {
    if (inHashMap.hasOwnProperty(k)) {
      keys.push(k);
    }
  }
  return keys;
};

export const resolveCallbackQueue = function(inQueue) {
  var length = inQueue.length;

  for (var i = 0; i < length; i++) {
    var callback = inQueue.shift();
    callback();
  }
};

export const singularize = function(string) {
  var singular = inflection.singularize.apply(this, arguments);
  if (!singular) {
    return string;
  }
  return singular;
};

export const log = function() {
  console.log.apply(console, args);
  return;
  if (db.Configuration.get("debug")) {
    var location = "";
    var stackFrameStrings = new Error().stack.split("\n");
    stackFrameStrings.splice(0, 2);
    location = "@ (" + stackFrameStrings[0].split("/").pop();
    var args = Array.prototype.slice.call(arguments, 0);
    args.push(location);

    console.log.apply(console, args);
  }
};

export const cap = function(string) {
  return string.slice(0, 1).toUpperCase() + string.slice(1);
};
