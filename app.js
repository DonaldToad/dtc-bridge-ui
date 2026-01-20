import { ethers } from "https://esm.sh/ethers@6.13.4";
import { Options } from "https://esm.sh/@layerzerolabs/lz-v2-utilities@3.0.85";

// ========= CONSTANTS =========
const ADDRS = {
  // Base
  BASE_OFT: "0xFbA669C72b588439B29F050b93500D8b645F9354",
  BASE_ROUTER: "0x480C0d523511dd96A65A38f36aaEF69aC2BaA82a", // optional (NOT used for peer/quote by default)

  // Linea
  LINEA_ADAPTER: "0x54B4E88E9775647614440Acc8B13A079277fa2A6",
  DTC_LINEA: "0xEb1fD1dBB8aDDA4fa2b5A5C4bcE34F6F20d125D2",
};

const CHAINS = {
  BASE:  { chainId: 8453,  name: "Base",  eid: 30184, currency: "ETH" },
  LINEA: { chainId: 59144, name: "Linea", eid: 30183, currency: "ETH" },
};

// ========= ABIs =========
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const OFT_ABI = [
  "function peer(uint32 dstEid) view returns (bytes32)",
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, bool payInLzToken) view returns (uint256 nativeFee, uint256 lzTokenFee)",
  "function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (bytes32 guid, uint64 nonce, (uint256 amountSentLD,uint256 amountReceivedLD) receipt)",
];

// ========= UI HELPERS =========
const $ = (id) => document.getElementById(id);

const logEl = $("log");
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function short(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function requireEthereum() {
  if (!window.ethereum) {
    alert("MetaMask not found. Install MetaMask and refresh.");
    throw new Error("No window.ethereum");
  }
  return window.ethereum;
}

function toBytes32Address(addr) {
  return ethers.zeroPadValue(addr, 32);
}

function parseAmount(amountStr, decimals) {
  if (!amountStr || isNaN(Number(amountStr))) throw new Error("Invalid amount");
  return ethers.parseUnits(amountStr, decimals);
}
function formatAmount(amountBN, decimals) {
  return ethers.formatUnits(amountBN, decimals);
}

function percentToMin(amountBN, slippagePct) {
  const slip = Number(slippagePct);
  const bps = Math.max(0, Math.min(100, slip)) * 100;
  const keepBps = 10000 - Math.round(bps);
  return (amountBN * BigInt(keepBps)) / 10000n;
}

function buildOptionsBytes(lzGas) {
  const gas = Number(lzGas);
  if (!Number.isFinite(gas) || gas <= 0) throw new Error("Invalid lzGas");
  // Official options builder -> avoids InvalidWorkerId(0x6780cfaf)
  return Options.newOptions().addExecutorLzReceiveOption(gas, 0).toBytes();
}

// ========= STATE =========
let browserProvider = null;
let signer = null;
let userAddress = null;

let isSwitching = false;     // lock while switching chains
let currentChainId = null;   // cached chainId

function setStatusLines() {
  $("walletLine").textContent = userAddress
    ? `Connected: ${short(userAddress)} (${userAddress})`
    : `Not connected`;
  $("netLine").textContent = `Network: ${currentChainId ?? "—"}`;
}

async function reinitProvider() {
  const eth = requireEthereum();
  browserProvider = new ethers.BrowserProvider(eth);
  signer = await browserProvider.getSigner();
  userAddress = await signer.getAddress();
  const net = await browserProvider.getNetwork();
  currentChainId = Number(net.chainId);
  setStatusLines();
}

function installListenersOnce() {
  const eth = requireEthereum();

  // IMPORTANT: Do NOT hard reload on chainChanged. We re-init cleanly.
  eth.removeAllListeners?.("chainChanged");
  eth.on?.("chainChanged", async () => {
    try {
      log(`Network changed. Re-initializing provider...`);
      await reinitProvider();
      await refreshAll();
    } catch (e) {
      log(`Re-init failed: ${e?.message || e}`);
    }
  });

  eth.removeAllListeners?.("accountsChanged");
  eth.on?.("accountsChanged", async (accs) => {
    if (!accs || !accs.length) return;
    try {
      log(`Account changed. Re-initializing provider...`);
      await reinitProvider();
      await refreshAll();
    } catch (e) {
      log(`Re-init failed: ${e?.message || e}`);
    }
  });
}

// ========= DIRECTION META (CRITICAL FIX: no router calls for peer/quote) =========
function getDirection() {
  return $("direction").value;
}

function directionMeta() {
  const dir = getDirection();

  if (dir === "LINEA_TO_BASE") {
    return {
      from: CHAINS.LINEA,
      to: CHAINS.BASE,

      // Token spent on Linea = canonical DTC ERC20
      token: ADDRS.DTC_LINEA,

      // Approve adapter to pull DTC
      spender: ADDRS.LINEA_ADAPTER,

      // OFT endpoint contract for quote/send on Linea is the ADAPTER
      oftEndpoint: ADDRS.LINEA_ADAPTER,
    };
  }

  // BASE_TO_LINEA
  return {
    from: CHAINS.BASE,
    to: CHAINS.LINEA,

    // Token spent on Base = OFT token itself (ERC20)
    token: ADDRS.BASE_OFT,

    // Approve OFT contract (common pattern)
    spender: ADDRS.BASE_OFT,

    // OFT endpoint contract for quote/send on Base is the OFT
    oftEndpoint: ADDRS.BASE_OFT,
  };
}

// ========= NETWORK SWITCH (LOCKED) =========
async function getChainId() {
  if (!browserProvider) return null;
  const net = await browserProvider.getNetwork();
  return Number(net.chainId);
}

async function switchNetwork(chainIdDec) {
  if (isSwitching) return;
  isSwitching = true;

  const eth = requireEthereum();
  const hex = "0x" + chainIdDec.toString(16);

  try {
    log(`Switching network to chainId=${chainIdDec}...`);
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    // chainChanged event will fire, which calls reinitProvider()
  } catch (e) {
    // If chain not added, add it
    const msg = String(e?.message || "");
    if (e && (e.code === 4902 || msg.includes("Unrecognized chain"))) {
      const params = (chainIdDec === CHAINS.LINEA.chainId)
        ? {
            chainId: hex,
            chainName: "Linea",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.linea.build"],
            blockExplorerUrls: ["https://lineascan.build"],
          }
        : {
            chainId: hex,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          };

      await eth.request({ method: "wallet_addEthereumChain", params: [params] });
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } else {
      throw e;
    }
  } finally {
    // small delay so ethers doesn’t race the chainChanged event
    setTimeout(() => { isSwitching = false; }, 800);
  }
}

// ========= CONTRACT READS =========
async function getTokenMeta(tokenAddr) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, browserProvider);
  const [sym, dec] = await Promise.all([token.symbol(), token.decimals()]);
  return { token, sym, dec: Number(dec) };
}

async function readPeer(oftEndpointAddr, dstEid) {
  const c = new ethers.Contract(oftEndpointAddr, OFT_ABI, browserProvider);
  const peerBytes32 = await c.peer(dstEid);

  // last 20 bytes as address
  const asAddr = ethers.getAddress("0x" + peerBytes32.slice(26));
  return { peerBytes32, asAddr };
}

// ========= QUOTE / APPROVE / SEND =========
async function quote() {
  if (!signer) throw new Error("Not connected");
  if (isSwitching) throw new Error("Switching network - try again in 1s");

  const meta = directionMeta();
  const chainId = await getChainId();

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    throw new Error(`Switched network. Click Quote again.`);
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);

  const amountStr = $("amount").value.trim();
  const slipStr = $("slippage").value.trim();
  const lzGas = $("lzGas").value.trim();

  const amount = parseAmount(amountStr, dec);
  const minAmount = percentToMin(amount, slipStr);

  const toB32 = toBytes32Address(userAddress);
  const extraOptions = buildOptionsBytes(lzGas);

  const sendParam = {
    dstEid: meta.to.eid,
    to: toB32,
    amountLD: amount,
    minAmountLD: minAmount,
    extraOptions: ethers.hexlify(extraOptions),
    composeMsg: "0x",
    oftCmd: "0x",
  };

  const endpoint = new ethers.Contract(meta.oftEndpoint, OFT_ABI, browserProvider);

  log(`Quote: ${meta.from.name} → ${meta.to.name} quoteOn=${meta.oftEndpoint} amount=${amountStr} min=${formatAmount(minAmount, dec)} ${sym}`);

  // Peer sanity (on the OFT endpoint only)
  try {
    const peer = await readPeer(meta.oftEndpoint, meta.to.eid);
    $("peerLine").textContent = `${peer.asAddr}`;
    log(`Diag: peer=${peer.asAddr}`);
  } catch (e) {
    // peer read should not block quoteSend; we log but continue
    $("peerLine").textContent = `—`;
    log(`Peer read failed: ${e?.shortMessage || e?.message || e}`);
  }

  const res = await endpoint.quoteSend(sendParam, false);
  const nativeFee = res[0];
  const lzTokenFee = res[1];

  $("feeLine").textContent = `${ethers.formatEther(nativeFee)} ${meta.from.currency}`;
  $("spenderLine").textContent = meta.spender;
  $("senderLine").textContent = meta.oftEndpoint;

  log(`Native fee: ${ethers.formatEther(nativeFee)} ${meta.from.currency}`);

  return { meta, token, sym, dec, sendParam, nativeFee, lzTokenFee };
}

async function approveIfNeeded() {
  if (!signer) throw new Error("Not connected");
  if (isSwitching) throw new Error("Switching network - try again in 1s");

  const meta = directionMeta();
  const chainId = await getChainId();

  if (chainId !== meta.from.chainId) {
    log(`Wrong network. Switching to ${meta.from.name}...`);
    await switchNetwork(meta.from.chainId);
    throw new Error(`Switched network. Click Approve again.`);
  }

  const { token, sym, dec } = await getTokenMeta(meta.token);
  const amountStr = $("amount").value.trim();
  const amount = parseAmount(amountStr, dec);

  const allowance = await token.allowance(userAddress, meta.spender);
  if (allowance >= amount) {
    log(`Approve not needed. allowance=${formatAmount(allowance, dec)} ${sym}`);
    return true;
  }

  log(`Approving spender=${meta.spender} for ${amountStr} ${sym}...`);
  const tx = await token.connect(signer).approve(meta.spender, amount);
  log(`Approve tx: ${tx.hash}`);
  await tx.wait();
  log(`Approve confirmed.`);
  return true;
}

async function send() {
  if (!signer) throw new Error("Not connected");
  if (isSwitching) throw new Error("Switching network - try again in 1s");

  const q = await quote();          // re-quote every time
  await approveIfNeeded();

  const endpoint = new ethers.Contract(q.meta.oftEndpoint, OFT_ABI, signer);

  const fee = { nativeFee: q.nativeFee, lzTokenFee: 0n };

  log(`Sending with msg.value=${ethers.formatEther(q.nativeFee)} ${q.meta.from.currency}...`);

  const tx = await endpoint.send(q.sendParam, fee, userAddress, { value: q.nativeFee });
  log(`Send tx: ${tx.hash}`);
  const rcpt = await tx.wait();
  log(`Send confirmed (source chain). status=${rcpt.status}`);
  log(`Delivery is async across chains.`);
}

// ========= REFRESH (DO NOT BREAK IF WRONG NETWORK) =========
async function refreshAll() {
  if (!signer) return;
  if (isSwitching) return;

  const meta = directionMeta();
  const chainId = await getChainId();
  currentChainId = chainId;
  setStatusLines();

  try {
    const { token, sym, dec } = await getTokenMeta(meta.token);
    const bal = await token.balanceOf(userAddress);
    $("balLine").textContent = `Balance: ${formatAmount(bal, dec)} ${sym}`;

    // Only read allowance/peer if we're on the correct chain for this direction
    if (chainId === meta.from.chainId) {
      const allowance = await token.allowance(userAddress, meta.spender);
      log(`Diag: chain=${meta.from.name} balance=${formatAmount(bal, dec)} ${sym} allowance=${formatAmount(allowance, dec)} ${sym}`);
      try {
        const peer = await readPeer(meta.oftEndpoint, meta.to.eid);
        $("peerLine").textContent = `${peer.asAddr}`;
      } catch {
        $("peerLine").textContent = `—`;
      }
    } else {
      $("peerLine").textContent = `—`;
    }
  } catch (e) {
    log(`Refresh error: ${e?.shortMessage || e?.message || e}`);
  }
}

// ========= OPTIONAL SIMULATE (ONLY IF YOU ENTER RPC) =========
async function simulateViaDebugRPC() {
  if (!signer) throw new Error("Not connected");
  if (isSwitching) throw new Error("Switching network - try again in 1s");

  const meta = directionMeta();
  const chainId = await getChainId();
  if (chainId !== meta.from.chainId) {
    log(`Simulate: switch to ${meta.from.name} first.`);
    return;
  }

  const rpc = (meta.from.chainId === CHAINS.LINEA.chainId)
    ? $("rpcLinea").value.trim()
    : $("rpcBase").value.trim();

  if (!rpc) {
    log(`Simulate failed: No Debug RPC URL set for ${meta.from.name}.`);
    return;
  }

  const q = await quote();
  const iface = new ethers.Interface(OFT_ABI);
  const data = iface.encodeFunctionData("send", [
    q.sendParam,
    { nativeFee: q.nativeFee, lzTokenFee: 0n },
    userAddress,
  ]);

  log(`SIMULATE (Debug RPC): ${meta.from.name} send() on ${meta.oftEndpoint}`);

  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: meta.oftEndpoint,
          from: userAddress,
          data,
          value: ethers.toBeHex(q.nativeFee),
        },
        "latest",
      ],
    }),
  });

  const json = await res.json();
  if (json.error) {
    const errData = json.error?.data;
    log(`eth_call reverted: ${json.error?.message || "execution reverted"}`);
    if (typeof errData === "string" && errData.startsWith("0x")) {
      log(`FOUND revert hex: ${errData}`);
      log(`selector: ${errData.slice(0, 10)}`);
    } else {
      log(`No revert hex. error=${JSON.stringify(json.error)}`);
    }
    return;
  }

  log(`eth_call OK. result=${String(json.result).slice(0, 66)}...`);
}

// ========= WIRE UI =========
$("btnConnect").onclick = async () => {
  try {
    installListenersOnce();
    await requireEthereum().request({ method: "eth_requestAccounts" });
    await reinitProvider();
    log(`Connected: ${userAddress}`);
    await refreshAll();
  } catch (e) {
    log(`Connect failed: ${e?.message || e}`);
  }
};

$("btnSwitchLinea").onclick = () => switchNetwork(CHAINS.LINEA.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));
$("btnSwitchBase").onclick = () => switchNetwork(CHAINS.BASE.chainId).catch(e => log(`Switch failed: ${e?.message || e}`));

$("btnRefresh").onclick = () => refreshAll();
$("btnQuote").onclick = () => quote().catch(e => log(`Quote failed: ${e?.shortMessage || e?.message || e}`));
$("btnApprove").onclick = () => approveIfNeeded().catch(e => log(`Approve failed: ${e?.shortMessage || e?.message || e}`));
$("btnSend").onclick = () => send().catch(e => log(`Send flow failed: ${e?.shortMessage || e?.message || e}`));
$("btnSimulate").onclick = () => simulateViaDebugRPC().catch(e => log(`Simulate failed: ${e?.shortMessage || e?.message || e}`));

$("btnClear").onclick = () => { logEl.textContent = ""; };

$("direction").onchange = async () => {
  $("feeLine").textContent = "—";
  await refreshAll();
};

window.addEventListener("load", () => {
  $("spenderLine").textContent = "—";
  $("senderLine").textContent = "—";
  $("peerLine").textContent = "—";
  $("feeLine").textContent = "—";
  $("balLine").textContent = "Balance: —";
  $("walletLine").textContent = "Not connected";
  $("netLine").textContent = "Network: —";
  log(`Ready. Click "Connect Wallet".`);
});
