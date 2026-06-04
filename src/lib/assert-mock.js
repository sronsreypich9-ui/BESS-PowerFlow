export default function assert(value, message) {
  if (!value) throw new Error(message || "Assertion failed");
}
assert.ok = assert;
assert.equal = function (a, b, msg) {
  if (a != b) throw new Error(msg || `${a} == ${b}`);
};
assert.strictEqual = function (a, b, msg) {
  if (a !== b) throw new Error(msg || `${a} === ${b}`);
};
assert.notEqual = function (a, b, msg) {
  if (a == b) throw new Error(msg || `${a} != ${b}`);
};
assert.notStrictEqual = function (a, b, msg) {
  if (a === b) throw new Error(msg || `${a} !== ${b}`);
};
assert.throws = function (fn) {
  try { fn(); } catch (_) { return; }
  throw new Error("Expected block to throw");
};
