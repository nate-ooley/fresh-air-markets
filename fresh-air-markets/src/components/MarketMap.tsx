"use client";

import { useCallback, useRef, useState } from "react";
import { BoothWithAvailability, BoothStatus } from "@/lib/types";

export const MAP_W = 1200;
export const MAP_H = 820;

interface MarketMapProps {
  booths: BoothWithAvailability[];
  /** Compute display status for a booth (lets callers scope it to a weekend). */
  statusFor?: (booth: BoothWithAvailability) => BoothStatus;
  selectedId?: string | null;
  onSelect?: (booth: BoothWithAvailability) => void;
  /** Admin mode: drag booths, show occupant names on rented booths. */
  draggable?: boolean;
  onMove?: (id: string, x: number, y: number) => void;
  showOccupants?: boolean;
}

const FILL: Record<BoothStatus, string> = {
  available: "#ffffff",
  partial: "#fdeed3",
  rented: "#2d6647",
};
const STROKE: Record<BoothStatus, string> = {
  available: "#8fb9a0",
  partial: "#e3a23c",
  rented: "#1e4632",
};

export default function MarketMap({
  booths,
  statusFor,
  selectedId,
  onSelect,
  draggable = false,
  onMove,
  showOccupants = false,
}: MarketMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<BoothWithAvailability | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const dragMoved = useRef(false);

  const toMapCoords = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * MAP_W,
      y: ((e.clientY - rect.top) / rect.height) * MAP_H,
    };
  }, []);

  const startDrag = (booth: BoothWithAvailability, e: React.PointerEvent) => {
    if (!draggable) return;
    const p = toMapCoords(e);
    dragMoved.current = false;
    setDrag({ id: booth.id, dx: p.x - booth.x, dy: p.y - booth.y, x: booth.x, y: booth.y });
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toMapCoords(e);
    dragMoved.current = true;
    setDrag({
      ...drag,
      x: Math.max(0, Math.min(MAP_W - 40, p.x - drag.dx)),
      y: Math.max(0, Math.min(MAP_H - 40, p.y - drag.dy)),
    });
  };

  const endDrag = () => {
    if (drag && dragMoved.current) {
      onMove?.(drag.id, Math.round(drag.x), Math.round(drag.y));
    }
    setDrag(null);
  };

  const hoveredStatus = hovered ? (statusFor ? statusFor(hovered) : hovered.status) : null;

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="w-full h-auto select-none rounded-3xl shadow-xl ring-1 ring-pine/10 touch-none"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          setHovered(null);
        }}
      >
        <defs>
          <linearGradient id="lawn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e9f2e4" />
            <stop offset="100%" stopColor="#d8e8d0" />
          </linearGradient>
          <pattern id="awning" width="16" height="8" patternUnits="userSpaceOnUse">
            <rect width="16" height="8" fill="#c8552c" />
            <rect width="8" height="8" fill="#e8734a" />
          </pattern>
          <pattern id="awning-green" width="16" height="8" patternUnits="userSpaceOnUse">
            <rect width="16" height="8" fill="#1e4632" />
            <rect width="8" height="8" fill="#2d6647" />
          </pattern>
          <filter id="boothShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#14311f" floodOpacity="0.18" />
          </filter>
        </defs>

        {/* Grounds */}
        <rect width={MAP_W} height={MAP_H} fill="url(#lawn)" rx="28" />

        {/* Walkway hugging the inside of the U */}
        <path
          d="M 210 130 L 210 640 Q 210 660 230 660 L 990 660 Q 1010 660 1010 640 L 1010 130"
          fill="none"
          stroke="#efe6d3"
          strokeWidth="90"
          strokeLinecap="round"
          opacity="0.9"
        />
        <path
          d="M 210 130 L 210 640 Q 210 660 230 660 L 990 660 Q 1010 660 1010 640 L 1010 130"
          fill="none"
          stroke="#d8cbb0"
          strokeWidth="2"
          strokeDasharray="10 12"
          opacity="0.8"
        />

        {/* Entrance marker at the open top of the U */}
        <g fontFamily="var(--font-body)" textAnchor="middle">
          <path d="M 560 60 L 600 24 L 640 60" fill="none" stroke="#b4532a" strokeWidth="5" strokeLinecap="round" />
          <text x="600" y="86" fontSize="22" fill="#7a6a52" letterSpacing="4" fontWeight="600">
            ENTRANCE
          </text>
        </g>

        {/* Stage lawn between entrance and center island */}
        <g>
          <circle cx="600" cy="170" r="46" fill="#cfe3c4" stroke="#a9c99a" strokeWidth="2" strokeDasharray="6 6" />
          <text x="600" y="176" fontSize="16" fill="#5c7a53" textAnchor="middle" fontWeight="600" letterSpacing="2">
            STAGE
          </text>
        </g>

        {/* Trees for warmth */}
        {[
          [50, 60], [1150, 60], [50, 780], [1150, 780], [600, 620],
        ].map(([cx, cy], i) => (
          <g key={i}>
            <circle cx={cx} cy={cy} r="22" fill="#7fae83" opacity="0.7" />
            <circle cx={cx - 10} cy={cy + 8} r="14" fill="#94bf90" opacity="0.7" />
          </g>
        ))}

        {/* Booths */}
        {booths.map((booth) => {
          const status = statusFor ? statusFor(booth) : booth.status;
          const isSel = booth.id === selectedId;
          const isDragging = drag?.id === booth.id;
          const x = isDragging ? drag.x : booth.x;
          const y = isDragging ? drag.y : booth.y;
          const rented = status === "rented";
          const occupant = showOccupants ? booth.occupants?.[0] : undefined;

          return (
            <g
              key={booth.id}
              transform={`translate(${x}, ${y})`}
              className={draggable ? "booth-draggable" : "cursor-pointer"}
              onPointerDown={(e) => startDrag(booth, e)}
              onPointerUp={() => {
                if (!dragMoved.current) onSelect?.(booth);
              }}
              onPointerEnter={() => setHovered(booth)}
              onPointerLeave={() => setHovered((h) => (h?.id === booth.id ? null : h))}
            >
              {isSel && (
                <rect
                  x={-6} y={-6} width={booth.w + 12} height={booth.h + 12} rx="14"
                  fill="none" stroke="#d97a1a" className="selected-ring"
                />
              )}
              <rect
                width={booth.w} height={booth.h} rx="10"
                fill={isSel ? "#f8b25c" : FILL[status]}
                stroke={isSel ? "#b4640f" : STROKE[status]}
                strokeWidth={hovered?.id === booth.id ? 3 : 2}
                filter="url(#boothShadow)"
              />
              {/* Striped awning across the top edge */}
              <rect
                width={booth.w} height={10} rx="5"
                fill={rented ? "url(#awning-green)" : "url(#awning)"}
                opacity={status === "available" && !isSel ? 0.85 : 1}
              />
              <text
                x={booth.w / 2}
                y={occupant ? booth.h / 2 + 1 : booth.h / 2 + 7}
                textAnchor="middle"
                fontSize={occupant ? 17 : 20}
                fontWeight="700"
                fill={rented ? "#f3f8f2" : "#2b4a38"}
                fontFamily="var(--font-body)"
              >
                {booth.label}
              </text>
              {occupant && (
                <text
                  x={booth.w / 2} y={booth.h / 2 + 17} textAnchor="middle" fontSize="10.5"
                  fill={rented ? "#cfe3d3" : "#7a6a52"} fontFamily="var(--font-body)"
                >
                  {occupant.businessName.length > 15
                    ? occupant.businessName.slice(0, 14) + "…"
                    : occupant.businessName}
                </text>
              )}
              {!occupant && rented && (
                <text
                  x={booth.w / 2} y={booth.h / 2 + 22} textAnchor="middle" fontSize="10"
                  fill="#cfe3d3" fontFamily="var(--font-body)" letterSpacing="1"
                >
                  RENTED
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {hovered && !drag && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-pine-deep px-3.5 py-2.5 text-cream shadow-lg"
          style={{
            left: `${((hovered.x + hovered.w / 2) / MAP_W) * 100}%`,
            top: `${(hovered.y / MAP_H) * 100 - 1.5}%`,
          }}
        >
          <div className="text-sm font-bold">
            Booth {hovered.label}
            <span className="ml-2 font-normal text-amber-soft">${hovered.pricePerDay}/day</span>
          </div>
          <div className="text-xs opacity-80">
            {hovered.zone}
            {showOccupants && hovered.occupants?.[0]
              ? ` · ${hovered.occupants[0].businessName} (${hovered.occupants[0].category})`
              : ""}
          </div>
        </div>
      )}
    </div>
  );
}
