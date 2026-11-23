// Inside the namespace: the one door. TCP on loopback -> a unix socket that the proxy outside listens on.
import net from "node:net";
const [port, sock] = process.argv.slice(2);
net.createServer((c) => { const u = net.connect(sock); c.pipe(u); u.pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }).listen(Number(port), "127.0.0.1");
