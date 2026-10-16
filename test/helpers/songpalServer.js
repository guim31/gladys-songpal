// -----------------------------------------------------------------------------
// The fake device of the tests (fakeSongpal.js) over real HTTP and WebSocket:
// used by test/notifier.test.js on the loopback interface, and by hand to try
// the integration container against a "device" without the hardware:
//
//   node test/helpers/songpalServer.js              # HT-ZF9 on port 10000, or $PORT
//   SONGPAL_FIXTURE=str-dn1080 node test/helpers/songpalServer.js
// -----------------------------------------------------------------------------

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { FakeSongpal } from './fakeSongpal.js';

/**
 * @param {FakeSongpal} device
 * @returns {http.Server}
 */
export function createSongpalServer(device) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const answer = device.handle({
        url: `http://${req.headers.host ?? 'localhost'}${req.url}`,
        method: req.method,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const service = new URL(req.url, 'http://localhost').pathname.replace(/^\/sony\//, '');
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const link = device.attach(service, (text) => {
        if (text === null) {
          ws.terminate();
        } else if (ws.readyState === ws.OPEN) {
          ws.send(text);
        }
      });
      ws.on('message', (data) => link.receive(data.toString()));
      ws.on('close', () => link.close());
    });
  });
  // `closeAllConnections` ends the HTTP ones; the sockets go with it.
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    for (const client of sockets.clients) {
      client.terminate();
    }
    sockets.close();
    closeAll();
  };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  const device = new FakeSongpal(process.env.SONGPAL_FIXTURE || 'ht-zf9');
  const port = Number(process.env.PORT || 10000);
  createSongpalServer(device).listen(port, () => {
    console.log(`Fake ${device.name} listening on port ${port}`);
  });
  // Every 20 s, someone takes the remote: the notifications have something to say.
  let turn = 0;
  setInterval(() => {
    turn += 1;
    device.changeVolume(10 + (turn % 10));
    if (turn % 3 === 0) {
      device.play(turn % 2 ? 'extInput:hdmi?port=1' : 'extInput:tv');
    }
    console.log(`Remote: volume ${device.mainVolume.volume}, source ${device.playing[0]?.uri}`);
  }, 20_000).unref();
}
