import axios from "axios";
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { tcp } from "@libp2p/tcp";
import { bootstrap } from "@libp2p/bootstrap";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { mplex } from "@libp2p/mplex";
import { createFromJSON } from "@libp2p/peer-id-factory";
import { identify } from "@libp2p/identify";
import { kadDHT, removePrivateAddressesMapper } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { mdns } from "@libp2p/mdns";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import {
  circuitRelayServer,
  circuitRelayTransport,
} from "@libp2p/circuit-relay-v2";
import { prometheusMetrics } from "@libp2p/prometheus-metrics";
import os from "node:os";
import drain from "it-drain";
import * as ipfsHttpClient from "ipfs-http-client";
import { delegatedPeerRouting } from "@libp2p/delegated-peer-routing";
import { delegatedContentRouting } from "@libp2p/delegated-content-routing";

const PUBLIC_IP = process.env.PUBLIC_IP;
const KUBO_API_SERVICE =
  process.env.KUBO_API_SERVICE || "http://127.0.0.1:5001";
const PEER_ID_JSON = JSON.parse(process.env.PEER_ID_JSON);
const peerId = await createFromJSON(PEER_ID_JSON);
const libp2p = await createLibp2p({
  peerId,
  peerRouting: [
    delegatedPeerRouting(
      ipfsHttpClient.create({
        host: "node0.delegate.ipfs.io", // In production you should setup your own delegates
        protocol: "https",
        port: 443,
      }),
    ),
  ],
  contentRouting: [
    delegatedContentRouting(
      ipfsHttpClient.create({
        host: "node0.delegate.ipfs.io", // In production you should setup your own delegates
        protocol: "https",
        port: 443,
      }),
    ),
  ],
  addresses: {
    listen: ["/ip4/0.0.0.0/tcp/4021"],
    announce: [`/ip4/${PUBLIC_IP}/tcp/4021`],
  },
  transports: [tcp(), webSockets(), circuitRelayTransport()],
  peerDiscovery: [
    mdns(),
    bootstrap({
      list: [
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
        "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
        "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
      ],
    }),
  ],
  connectionEncryption: [noise()],
  connectionManager: {
    minConnections: 300,
    maxParallelDials: 150, // 150 total parallel multiaddr dials
    maxDialsPerPeer: 4, // Allow 4 multiaddrs to be dialed per peer in parallel
    dialTimeout: 10e3, // 10 second dial timeout per peer dial
    autoDial: true,
  },
  nat: {
    enabled: true,
    description: `ipfs@${os.hostname()}`,
  },
  streamMuxers: [yamux(), mplex()],
  services: {
    identify: identify(),
    dht: kadDHT({
      kBucketSize: 20,
      protocol: "/ipfs/kad/1.0.0",
      addressFilter: removePrivateAddressesMapper,
      clientMode: true,
    }),
    relay: circuitRelayServer({ advertise: true }),
    ping: ping(),
  },
  metrics: prometheusMetrics(),
  start: true,
});
const helia = await createHelia({
  libp2p,
  start: false,
});
await helia.start();
const fs = unixfs(helia);
await helia.libp2p.services.dht.refreshRoutingTable();
console.log(`Initialized Helia`);
console.info("PeerId:", helia.libp2p.peerId.toString());

const runExample = async () => {
  const isHeliaReady = helia.libp2p.status === "started";
  if (isHeliaReady === false) {
    console.log(`Waiting for Helia`);
  } else {
    console.log(`Multiaddrs: ${helia.libp2p.getMultiaddrs()}`);
    const textToAdd = `Hello DHT the Time is ${Date.now()}!`;
    console.log(`Adding File: [${textToAdd}]`);
    const cid = await fs.addBytes(Buffer.from(textToAdd));
    console.log(`Added CID: ${cid.toString()}`);
    try {
      console.log(`Checking Peer ID: ${peerId.toString()}`);
      const findPeerResult = await axios.post(
        `${KUBO_API_SERVICE}/api/v0/routing/findpeer`,
        null,
        {
          params: {
            arg: peerId.toString(),
          },
          validateStatus: function (status) {
            return status === 200 || status === 404;
          },
        },
      );
      if (findPeerResult.status === 200) {
        console.log(`Peer ID Found in DHT`);
      } else {
        console.error(`Peer ID Not Found in DHT`);
      }
      console.log(`Announcing CID: ${cid.toString()}`);
      await drain(
        helia.libp2p.services.dht.provide(cid, {
          recursive: true,
        }),
      );
      console.log(`Checking CID: ${cid.toString()}`);
      const findProvsResult = await axios.post(
        `${KUBO_API_SERVICE}/api/v0/routing/findprovs`,
        null,
        {
          params: {
            arg: cid.toString(),
          },
          validateStatus: function (status) {
            return status === 200 || status === 404;
          },
        },
      );
      //TODO: Check for FINAL_PEER event instead
      if (findProvsResult.status === 200) {
        console.log(`CID Found in DHT`);
      } else {
        console.error(`CID Not Found in DHT`);
      }
    } catch (err) {
      console.error(
        `Error Announcing CID: ${cid.toString()} - ${err?.message}`,
      );
    }
  }
  setTimeout(runExample, 1000);
};

setTimeout(runExample, 1000);
