const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const mime = {
  ".html": "text/html;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
  ".png": "image/png",
  ".css": "text/css",
  ".json": "application/json"
};
const port = Number(process.env.PORT || 28222);

const server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(String((req.url || "/").split("?")[0] || "/"));
  if (urlPath === "/") urlPath = "/index.html";
  var full = path.resolve(root, "." + urlPath.split("/").join(path.sep));
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  var ext = String(path.extname(full) || "").toLowerCase();
  res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
});

server.listen(port, "127.0.0.1", function () {
  console.log("READY http://127.0.0.1:" + port);
});
