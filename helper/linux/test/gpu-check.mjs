// Same app, CPU path vs GL path (VIVARIUM_GPU=software: shm buffers imported into GLES and read
// back, the code dmabufs use): the settled frames must match, and GL must actually be used.
//   node test/gpu-check.mjs [app argv…]      (default: gtk3-demo)
import { spawn } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";

function writePng(file, px, w, h, stride) {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const s = y * stride + x * 4, d = y * (w * 4 + 1) + 1 + x * 4;
		raw[d] = px[s + 2]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s]; raw[d + 3] = 255;
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const BIN = process.env.HELPER_BIN || "target/release/vivarium-helper-linux";
const argv = process.argv.slice(2).length ? process.argv.slice(2) : ["gtk3-demo"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(gpu) {
	const env = { ...process.env };
	if (gpu) env.VIVARIUM_GPU = "software";
	const p = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"], env });
	let buf = Buffer.alloc(0), id = 1, fd = null, last = null, lastAt = 0;
	const pending = new Map();
	const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
	const req = (op, params = {}) => new Promise((res) => { const i = id++; pending.set(i, res); send({ id: i, op, ...params }); });
	p.stdout.on("data", (c) => {
		buf = Buffer.concat([buf, c]);
		let off = 0;
		while (buf.length - off >= 5) {
			const len = buf.readUInt32BE(off);
			if (buf.length - off < 4 + len) break;
			const t = buf[off + 4], pl = buf.subarray(off + 5, off + 4 + len);
			off += 4 + len;
			if (t === 1) {
				const m = JSON.parse(pl);
				if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
				if (m.ev === "frame_buffer") fd = fs.openSync(m.path, "r");
			} else if (t === 3) {
				const w = pl.readUInt32BE(0), seq = pl.readUInt32BE(4), W = pl.readUInt32BE(8), H = pl.readUInt32BE(12), S = pl.readUInt32BE(16), O = Number(pl.readBigUInt64BE(20));
				if (fd !== null) { const px = Buffer.alloc(S * H); fs.readSync(fd, px, 0, S * H, O); last = { px, W, H, S }; lastAt = Date.now(); }
				send({ op: "frame_ack", windowId: w, seq });
			}
		}
		buf = Buffer.from(buf.subarray(off));
	});
	await req("launch", { argv, width: 900, height: 600, env: { GTK_CURSOR_BLINK: "0" } });
	const t0 = Date.now();
	while ((!last || Date.now() - lastAt < 2500) && Date.now() - t0 < 60000) await sleep(200);
	const hello = await req("hello");
	p.kill("SIGTERM");
	return { frame: last, gpu: hello.gpu };
}

const cpu = await run(false);
const gl = await run(true);
if (!cpu.frame || !gl.frame) { console.log(JSON.stringify({ ok: false, error: "no frame", cpu: !!cpu.frame, gl: !!gl.frame })); process.exit(1); }
let diff = 0;
const n = Math.min(cpu.frame.px.length, gl.frame.px.length) / 4;
for (let i = 0; i < n; i++) if (cpu.frame.px.readUInt32LE(i * 4) !== gl.frame.px.readUInt32LE(i * 4)) diff++;
fs.mkdirSync("test/out", { recursive: true });
for (const [name, r] of [["cpu", cpu], ["gl", gl]]) writePng(`test/out/gpu-check-${argv[0]}-${name}.png`, r.frame.px, r.frame.W, r.frame.H, r.frame.S);
const ok = gl.gpu?.enabled && gl.gpu.imports > 0 && gl.gpu.failures === 0 && cpu.frame.W === gl.frame.W && diff / n < 0.01;
console.log(JSON.stringify({ ok, app: argv[0], size: [gl.frame.W, gl.frame.H], differingPixels: diff, ofPixels: n, gpu: gl.gpu, cpuGpu: cpu.gpu }, null, 1));
process.exit(ok ? 0 : 1);
