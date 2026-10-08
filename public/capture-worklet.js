// AudioWorklet: sammelt Mono-Samples und schickt sie blockweise an den Haupt-Thread
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chs = input.length;
      const n = input[0].length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < chs; c++) s += input[c][i];
        this.buf[this.pos++] = s / chs;
        if (this.pos === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(4096);
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
