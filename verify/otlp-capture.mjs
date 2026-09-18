import http from "node:http";
let captured = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/metrics") { captured = body; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
server.listen(4319, "127.0.0.1", () => console.log("capture on 4319"));
process.on("SIGTERM", () => { if (captured) console.log("CAPTURED:" + captured); server.close(); process.exit(0); });
