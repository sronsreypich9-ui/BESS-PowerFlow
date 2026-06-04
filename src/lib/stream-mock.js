class Dummy {
  on() { return this; }
  once() { return this; }
  off() { return this; }
  emit() { return true; }
  addEventListener() {}
  removeEventListener() {}
}
export class Stream extends Dummy {}
export class Readable extends Stream {
  read() { return null; }
  pipe(dest) { return dest; }
}
export class Writable extends Stream {
  write() { return true; }
  end() {}
}
export class Duplex extends Readable {}
export class Transform extends Duplex {
  _transform(chunk, encoding, callback) {
    if (typeof callback === 'function') callback();
  }
}
export default { Stream, Readable, Writable, Duplex, Transform };
