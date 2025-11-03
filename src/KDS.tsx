import React, { useEffect, useMemo, useRef, useState } from "react";

// ---- CONFIG ----
const USE_MOCK = false; // <- change to false when your Go backend is ready

const ENDPOINTS = {
  list: "/api/kds/orders",
  update: (id: string) => `/api/kds/orders/${id}`,
};
const WS_URL = (location.origin || "").replace("http", "ws") + "/api/kds/ws";
const STATIONS = ["All", "Grill", "Fry", "Cold", "Dessert", "Bar", "Expo"] as const;
const STATUSES = ["NEW", "COOKING", "READY"] as const;
const SLA = { warn: 7 * 60, late: 12 * 60 }; // in seconds

type Station = typeof STATIONS[number];
type Status = typeof STATUSES[number];

interface KdsItem {
  name: string;
  qty: number;
  mods?: string[];
  station?: Station;
}

export interface KdsOrder {
  id: string;
  orderNumber: string;
  table?: string;
  customerName?: string;
  type: "DINE_IN" | "TAKEOUT" | "DELIVERY";
  station: Station;
  status: Status;
  items: KdsItem[];
  notes?: string;
  createdAt: string;
  bumpedAt?: string;
}

// ---- UTILITIES ----
const nowSec = () => Math.floor(Date.now() / 1000);
const isoToSec = (iso?: string) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : nowSec());
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
function formatDuration(totalSec: number) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad2(s)}`;
}
function ageColor(ageSec: number) {
  if (ageSec >= SLA.late) return "bg-red-600 text-white";
  if (ageSec >= SLA.warn) return "bg-yellow-500 text-black";
  return "bg-emerald-600 text-white";
}
async function jfetch(input: RequestInfo, init?: RequestInit, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- MOCK ORDERS ----
function makeMockOrders(): KdsOrder[] {
  const base = new Date();
  const ago = (mins: number) => new Date(base.getTime() - mins * 60000).toISOString();
  return [
    {
      id: "101",
      orderNumber: "101",
      table: "A2",
      type: "DINE_IN",
      station: "Grill",
      status: "NEW",
      createdAt: ago(2),
      items: [
        { name: "Cheeseburger", qty: 2, mods: ["no pickles", "add bacon"], station: "Grill" },
        { name: "Fries", qty: 1, station: "Fry" },
      ],
      notes: "Allergy: peanut",
    },
    {
      id: "102",
      orderNumber: "102",
      type: "TAKEOUT",
      station: "Fry",
      status: "COOKING",
      createdAt: ago(8),
      items: [{ name: "Chicken Tenders", qty: 1, mods: ["extra crispy"], station: "Fry" }],
    },
    {
      id: "103",
      orderNumber: "103",
      type: "DELIVERY",
      station: "Cold",
      status: "READY",
      createdAt: ago(13),
      items: [{ name: "Caesar Salad", qty: 1, mods: ["no croutons"], station: "Cold" }],
    },
  ];
}

// ---- MAIN COMPONENT ----
export default function KDS() {
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [station, setStation] = useState<Station>("All");
  const [query, setQuery] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [lastSeenIds, setLastSeenIds] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load orders (mock or API)
  useEffect(() => {
  let cancelled = false;

  const load = async () => {
    setLoading(true);
    try {
      const res = (await jfetch(ENDPOINTS.list)) as KdsOrder[];
      if (!cancelled) {
        setOrders(res);
        setLoading(false);
      }
    } catch (e) {
      console.warn("KDS: failed to load from API", e);
      if (!cancelled) {
        setOrders([]);           // <--- show empty instead of mock
        setLoading(false);
      }
    }
  };

  load();
  const iv = setInterval(load, 10_000);
  return () => {
    cancelled = true;
    clearInterval(iv);
  };
}, []);

  // Sound alert for new tickets
  useEffect(() => {
    const currentIds = new Set(orders.map((o) => o.id));
    if (soundOn && audioRef.current) {
      for (const o of orders) {
        if (!lastSeenIds.has(o.id)) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(() => {});
        }
      }
    }
    setLastSeenIds(currentIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  // Filters + sorting
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      const stationOk = station === "All" || o.station === station;
      const qOk =
        !q ||
        o.orderNumber.toLowerCase().includes(q) ||
        (o.table || "").toLowerCase().includes(q) ||
        (o.customerName || "").toLowerCase().includes(q) ||
        o.items.some((it) => it.name.toLowerCase().includes(q));
      return stationOk && qOk;
    });
  }, [orders, station, query]);

  const lanes = useMemo(() => {
    const by: Record<Status, KdsOrder[]> = { NEW: [], COOKING: [], READY: [] };
    for (const o of filtered) by[o.status].push(o);
    for (const k of STATUSES)
      by[k as Status].sort((a, b) => isoToSec(a.createdAt) - isoToSec(b.createdAt));
    return by;
  }, [filtered]);

  async function setStatus(id: string, status: Status) {
    setOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status, bumpedAt: new Date().toISOString() } : o))
    );
    if (!USE_MOCK) {
      try {
        await jfetch(ENDPOINTS.update(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch {
        console.warn("Failed to update backend; will stay local");
      }
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 p-4">
      <audio
        ref={audioRef}
        src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYAAGZkYWFhYWFhYWFhYWFhYWFhYWFhYQ=="
        preload="auto"
      />

      <header className="flex flex-wrap items-center gap-3 mb-4">
        <div className="text-xl font-semibold">Kitchen Display</div>
        <div className="ml-auto flex items-center gap-2 w-full sm:w-auto">
          <input
            className="w-full sm:w-72 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 outline-none"
            placeholder="Search order #, table, item..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800"
            value={station}
            onChange={(e) => setStation(e.target.value as Station)}
          >
            {STATIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800"
          >
            Refresh
          </button>
          <button
            onClick={() => setSoundOn((s) => !s)}
           className={`px-3 py-2 rounded-lg ${
              soundOn ? "bg-emerald-600" : "bg-zinc-900 border border-zinc-800"
            }`}
          >
            {soundOn ? "Sound On" : "Sound Off"}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Lane
          title="New"
          orders={lanes.NEW}
          onBump={(id) => setStatus(id, "COOKING")}
          onDone={(id) => setStatus(id, "READY")}
        />
        <Lane
          title="Cooking"
          orders={lanes.COOKING}
          onBump={(id) => setStatus(id, "READY")}
          onRecall={(id) => setStatus(id, "NEW")}
        />
        <Lane
          title="Ready"
          orders={lanes.READY}
          onRecall={(id) => setStatus(id, "COOKING")}
          onDone={(id) => setOrders((prev) => prev.filter((o) => o.id !== id))}
        />
      </main>

      {loading && (
        <div className="fixed bottom-4 right-4 bg-zinc-900 border border-zinc-800 px-3 py-2 rounded-xl text-sm">
          Loading orders…
        </div>
      )}
    </div>
  );
}

// ---- SUPPORT COMPONENTS ----
function Lane({
  title,
  orders,
  onBump,
  onRecall,
  onDone,
}: {
  title: string;
  orders: KdsOrder[];
  onBump?: (id: string) => void;
  onRecall?: (id: string) => void;
  onDone?: (id: string) => void;
}) {
  return (
    <section className="bg-zinc-950 border border-zinc-800 rounded-2xl">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="text-lg">{title}</div>
        <span className="text-xs px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800">
          {orders.length}
        </span>
      </div>
      <div className="p-2 max-h-[calc(100vh-220px)] overflow-auto grid grid-cols-1 xl:grid-cols-2 gap-2">
        {orders.map((o) => (
          <TicketCard
            key={o.id}
            order={o}
            onBump={onBump}
            onRecall={onRecall}
            onDone={onDone}
          />
        ))}
      </div>
    </section>
  );
}

function TicketCard({
  order,
  onBump,
  onRecall,
  onDone,
}: {
  order: KdsOrder;
  onBump?: (id: string) => void;
  onRecall?: (id: string) => void;
  onDone?: (id: string) => void;
}) {
  const age = nowSec() - isoToSec(order.createdAt);
  const ageCls = ageColor(age);
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs px-2 py-1 rounded bg-zinc-800">#{order.orderNumber}</span>
          {order.table && (
            <span className="text-xs px-2 py-1 rounded bg-zinc-800">Table {order.table}</span>
          )}
          <span className="text-xs px-2 py-1 rounded bg-zinc-800">{order.type}</span>
          <span className="text-xs px-2 py-1 rounded bg-zinc-800">{order.station}</span>
        </div>
        <div className={`text-xs px-2 py-1 rounded font-mono ${ageCls}`}>
          {formatDuration(age)}
        </div>
      </div>

      <div className="my-2 h-px bg-zinc-800" />

      <ul className="space-y-2">
        {order.items.map((it, idx) => (
          <li
            key={idx}
            className="bg-zinc-950/50 rounded-xl border border-zinc-800 p-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">
                  {it.qty}× {it.name}
                </div>
                {!!it.mods?.length && (
                  <div className="text-xs text-zinc-400">{it.mods.join(", ")}</div>
                )}
              </div>
              {it.station && (
                <span className="text-xs px-2 py-1 rounded bg-zinc-900">
                  {it.station}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!!order.notes && (
        <div className="mt-2 text-xs text-zinc-300 italic">Note: {order.notes}</div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {onRecall && (
          <button
            className="px-3 py-2 rounded bg-zinc-950 border border-zinc-800"
            onClick={() => onRecall(order.id)}
          >
            Recall
          </button>
        )}
        {onBump && (
          <button
            className="px-3 py-2 rounded bg-emerald-600"
            onClick={() => onBump(order.id)}
          >
            Bump
          </button>
        )}
        {onDone && (
          <button
            className="px-3 py-2 rounded bg-red-600 ml-auto"
            onClick={() => onDone(order.id)}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

