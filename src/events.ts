import { EventEmitter } from "node:events";
import type { BusEvent } from "./types.ts";

class Bus extends EventEmitter {
  emitEvent(ev: BusEvent): void {
    this.emit("event", ev);
  }
  onEvent(fn: (ev: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
