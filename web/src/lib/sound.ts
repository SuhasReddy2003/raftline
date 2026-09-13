let ctx: AudioContext | null = null;

function getCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export function beep(freq: number, durationMs = 120, type: OscillatorType = "sine") {
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = freq;
  osc.type = type;
  gain.gain.setValueAtTime(0.05, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + durationMs / 1000);
}

export function soundForEvent(type: string) {
  switch (type) {
    case "election_started": beep(300, 80); break;
    case "leader_elected": beep(520, 160); break;
    case "committed": beep(720, 100); break;
    case "node_failed": beep(140, 200, "sawtooth"); break;
    case "node_recovered": beep(440, 120); break;
    case "partitioned": beep(200, 180, "square"); break;
    case "healed": beep(480, 140); break;
  }
}