import React from "react";

export function GridFormingResponseAnimation() {
  return (
    <div className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-4 select-none overflow-x-auto relative mt-2 shrink-0 transition-colors duration-300">
      {/* Dynamic phase CSS styling & animations */}
      <style>{`
        /* Custom CSS variables for theme support inside SVG */
        .dark .themed-svg {
          --bg-node: #1E293B;
          --stroke-node: #475569;
          --text-main: #F1F5F9;
          --text-sub: #94A3B8;
          --bg-panel: #0D1520;
          --border-panel: #1E293B;
        }
        
        .themed-svg {
          --bg-node: #FFFFFF;
          --stroke-node: #CBD5E1;
          --text-main: #0F172A;
          --text-sub: #64748B;
          --bg-panel: #F8FAFC;
          --border-panel: #E2E8F0;
        }

        /* Flowing particles keyframes */
        @keyframes flow-particles {
          0% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -40; }
        }
        
        .animate-flow-fast {
          stroke-dasharray: 6, 14;
          animation: flow-particles 0.8s linear infinite;
        }
        
        .animate-flow-slow {
          stroke-dasharray: 8, 16;
          animation: flow-particles 2s linear infinite;
        }
        
        .animate-flow-reverse {
          stroke-dasharray: 6, 14;
          animation: flow-particles 1s linear infinite reverse;
        }

        /* Target glows pulse */
        @keyframes pulse-ring {
          0% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.15); opacity: 0.3; }
          100% { transform: scale(0.95); opacity: 0.8; }
        }
        .pulse-glow {
          transform-origin: center;
          animation: pulse-ring 2s ease-in-out infinite;
        }

        /* PHASE ALTERNATION KEYFRAMES (8s cycle) */
        @keyframes terminal-phase {
          0%, 45% { opacity: 1; }
          50%, 100% { opacity: 0.15; }
        }
        
        @keyframes terminal-glow-phase {
          0%, 45% { opacity: 0.8; }
          50%, 100% { opacity: 0; }
        }

        @keyframes plant-phase {
          0%, 45% { opacity: 0.05; }
          50%, 100% { opacity: 1; }
        }

        @keyframes sppc-light-phase {
          0%, 45% { fill: #64748B; filter: none; }
          50%, 100% { fill: #EF4444; filter: drop-shadow(0 0 4px #EF4444); }
        }

        /* Apply phase animations */
        .phase-terminal-flow {
          animation: terminal-phase 8s infinite;
        }
        .phase-terminal-glow {
          animation: terminal-glow-phase 8s infinite;
        }
        .phase-plant-flow {
          animation: plant-phase 8s infinite;
        }
        .phase-sppc-light {
          animation: sppc-light-phase 8s infinite;
        }
      `}</style>

      {/* Header labels */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2 mb-3 shrink-0 select-none">
        <span className="text-[10px] uppercase font-bold tracking-widest text-slate-800 dark:text-sky-400 font-mono">
          ⚡ GRID-FORMING RESPONSE ARCHITECTURE (AUTO-LOOPING)
        </span>
        <div className="flex items-center gap-4 text-[9px] font-bold font-mono">
          <div className="flex items-center gap-1.5 phase-terminal-flow">
            <span className="w-2 h-2 rounded-full bg-blue-500"></span>
            <span className="text-slate-600 dark:text-slate-300">0-10 ms (Terminal)</span>
          </div>
          <div className="flex items-center gap-1.5 phase-plant-flow">
            <span className="w-2 h-2 rounded-full bg-red-500"></span>
            <span className="text-slate-600 dark:text-slate-300">&gt;10 ms (Plant)</span>
          </div>
        </div>
      </div>

      {/* SVG Canvas */}
      <svg className="themed-svg w-full h-auto min-w-[900px]" viewBox="0 0 1000 340">
        <defs>
          <marker id="arrow-red" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#EF4444" />
          </marker>
        </defs>

        {/* BACKGROUND LABELS & TIMELINES */}
        <text x="50" y="325" fill="var(--text-sub)" fontSize="9" fontWeight="bold" className="uppercase tracking-wider">Smart String ESS</text>
        <text x="210" y="325" fill="var(--text-sub)" fontSize="9" fontWeight="bold" className="uppercase tracking-wider">PCS Cabinets</text>
        <text x="460" y="325" fill="var(--text-sub)" fontSize="9" fontWeight="bold" className="uppercase tracking-wider">STS & SACU</text>
        <text x="680" y="325" fill="var(--text-sub)" fontSize="9" fontWeight="bold" className="uppercase tracking-wider">Booster Station</text>
        <text x="940" y="325" fill="var(--text-sub)" fontSize="9" fontWeight="bold" className="uppercase tracking-wider">Utility Grid</text>

        {/* DASHED GROUP BOUNDARIES */}
        <rect x="175" y="20" width="70" height="270" rx="6" fill="none" stroke="#EAB308" strokeWidth="1.5" strokeDasharray="6 4" opacity="0.3"/>
        <text x="210" y="280" fill="#EAB308" fontSize="9" fontWeight="bold" opacity="0.6" textAnchor="middle">PCS</text>

        <rect x="615" y="20" width="180" height="100" rx="6" fill="none" stroke="#EAB308" strokeWidth="1.5" stroke-dasharray="6 4" opacity="0.3"/>
        <text x="705" y="112" fill="#EAB308" fontSize="9" fontWeight="bold" opacity="0.6" textAnchor="middle">SEMS2000 / SPPC2000</text>

        {/* CONNECTION PATHS */}
        
        {/* Battery ➔ PCS */}
        <g stroke="#3B82F6" strokeWidth="2.5" fill="none" opacity="0.25">
          <path d="M 100 50 L 180 50" />
          <path d="M 100 110 L 180 110" />
          <path d="M 100 190 L 180 190" />
          <path d="M 100 250 L 180 250" />
        </g>
        <g stroke="#60A5FA" strokeWidth="3" fill="none" className="phase-terminal-flow">
          <path d="M 100 50 L 180 50" className="animate-flow-fast" />
          <path d="M 100 110 L 180 110" className="animate-flow-fast" />
          <path d="M 100 190 L 180 190" className="animate-flow-fast" />
          <path d="M 100 250 L 180 250" className="animate-flow-fast" />
        </g>

        {/* PCS ➔ STS */}
        <g stroke="#EF4444" strokeWidth="2.5" fill="none" opacity="0.25">
          <path d="M 230 50 L 320 50 L 320 95 L 430 95" />
          <path d="M 230 110 L 320 110 L 320 95" />
          <path d="M 230 190 L 320 190 L 320 225 L 430 225" />
          <path d="M 230 250 L 320 250 L 320 225" />
        </g>
        <g stroke="#F87171" strokeWidth="3" fill="none" className="phase-terminal-flow">
          <path d="M 230 50 L 320 50 L 320 95 L 430 95" className="animate-flow-fast" />
          <path d="M 230 110 L 320 110 L 320 95" className="animate-flow-fast" />
          <path d="M 230 190 L 320 190 L 320 225 L 430 225" className="animate-flow-fast" />
          <path d="M 230 250 L 320 250 L 320 225" className="animate-flow-fast" />
        </g>

        {/* STS ➔ Booster Station */}
        <path d="M 485 95 L 530 95 L 530 210 L 660 210" stroke="#EF4444" stroke-width="2.5" fill="none" opacity="0.25"/>
        <path d="M 485 225 L 660 225" stroke="#EF4444" stroke-width="2.5" fill="none" opacity="0.25"/>
        <g stroke="#F87171" stroke-width="3" fill="none" className="phase-terminal-flow">
          <path d="M 485 95 L 530 95 L 530 210 L 660 210" className="animate-flow-fast" />
          <path d="M 485 225 L 660 225" className="animate-flow-fast" />
        </g>

        {/* Booster Station ➔ Utility Grid */}
        <path d="M 710 218 L 930 218" stroke="#EF4444" stroke-width="2.5" fill="none" opacity="0.25"/>
        <path d="M 710 218 L 930 218" stroke="#F87171" stroke-width="3.5" fill="none" className="animate-flow-fast" />

        {/* Direct Sampling feedback Line */}
        <path d="M 830 218 L 830 75 L 750 75" stroke="#EF4444" stroke-width="2" strokeDasharray="5 5" fill="none" opacity="0.15"/>
        <path d="M 830 218 L 830 75 L 750 75" stroke="#EF4444" stroke-width="2.5" fill="none" className="animate-flow-reverse phase-plant-flow" markerEnd="url(#arrow-red)"/>

        {/* Control Command Loop Line */}
        <path d="M 710 80 L 710 300 L 210 300 L 210 270" stroke="#EF4444" stroke-width="2" fill="none" opacity="0.1"/>
        <path d="M 710 80 L 710 300 L 210 300 L 210 270" stroke="#EF4444" stroke-width="2.5" fill="none" className="animate-flow-fast phase-plant-flow" markerEnd="url(#arrow-red)"/>

        {/* COMMUNICATIONS LINES */}
        <g stroke="#64748B" strokeWidth="1.2" strokeDasharray="4 4" fill="none" opacity="0.3">
          <path d="M 95 65 H 175 M 175 65 V 265 M 95 125 H 175 M 95 205 H 175 M 95 265 H 175" />
          <path d="M 235 65 H 440 M 235 125 H 340 M 235 205 H 440 M 235 265 H 340" />
          <path d="M 480 50 V 25" />
          <path d="M 720 50 V 25" />
        </g>

        {/* 1. Smart String ESS Stack */}
        <g fill="var(--bg-node)" stroke="var(--stroke-node)" strokeWidth="1.5">
          {/* Bat 1 */}
          <rect x="35" y="25" width="65" height="42" rx="4" />
          <line x1="50" y1="35" x2="85" y2="35" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="45" x2="85" y2="45" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="55" x2="85" y2="55" stroke="var(--text-sub)" strokeWidth="3"/>
          {/* Bat 2 */}
          <rect x="35" y="85" width="65" height="42" rx="4" />
          <line x1="50" y1="95" x2="85" y2="95" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="105" x2="85" y2="105" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="115" x2="85" y2="115" stroke="var(--text-sub)" strokeWidth="3"/>
          {/* Bat 3 */}
          <rect x="35" y="165" width="65" height="42" rx="4" />
          <line x1="50" y1="175" x2="85" y2="175" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="185" x2="85" y2="185" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="195" x2="85" y2="195" stroke="var(--text-sub)" strokeWidth="3"/>
          {/* Bat 4 */}
          <rect x="35" y="225" width="65" height="42" rx="4" />
          <line x1="50" y1="235" x2="85" y2="235" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="245" x2="85" y2="245" stroke="var(--text-sub)" strokeWidth="3"/>
          <line x1="50" y1="255" x2="85" y2="255" stroke="var(--text-sub)" strokeWidth="3"/>
        </g>

        {/* 2. PCS Units */}
        <g fill="var(--bg-node)" stroke="var(--stroke-node)" strokeWidth="1.5">
          <rect x="185" y="30" width="45" height="36" rx="4" />
          <circle cx="208" cy="48" r="8" fill="none" stroke="#EAB308" strokeWidth="1"/>
          <path d="M 203 48 L 213 48" stroke="#EAB308" />

          <rect x="185" y="90" width="45" height="36" rx="4" />
          <circle cx="208" cy="108" r="8" fill="none" stroke="#EAB308" strokeWidth="1"/>
          <path d="M 203 108 L 213 108" stroke="#EAB308" />

          <rect x="185" y="170" width="45" height="36" rx="4" />
          <circle cx="208" cy="188" r="8" fill="none" stroke="#EAB308" strokeWidth="1"/>
          <path d="M 203 188 L 213 188" stroke="#EAB308" />

          <rect x="185" y="230" width="45" height="36" rx="4" />
          <circle cx="208" cy="248" r="8" fill="none" stroke="#EAB308" strokeWidth="1"/>
          <path d="M 203 248 L 213 248" stroke="#EAB308" />
        </g>
        
        {/* Local Spontaneous Response Target Ring */}
        <g className="phase-terminal-glow">
          <circle cx="208" cy="48" r="14" fill="none" stroke="#3B82F6" strokeWidth="1.5" className="pulse-glow" />
          <circle cx="208" cy="108" r="14" fill="none" stroke="#3B82F6" strokeWidth="1.5" className="pulse-glow" />
          <circle cx="208" cy="188" r="14" fill="none" stroke="#3B82F6" strokeWidth="1.5" className="pulse-glow" />
          <circle cx="208" cy="248" r="14" fill="none" stroke="#3B82F6" strokeWidth="1.5" className="pulse-glow" />
        </g>

        {/* 3. STS & SACU Modules */}
        <g fill="var(--bg-node)" stroke="var(--stroke-node)" strokeWidth="1.5">
          {/* Upper STS */}
          <rect x="430" y="70" width="55" height="46" rx="4" />
          <text x="457" y="85" fill="var(--text-main)" fontSize="8" textAnchor="middle" fontWeight="bold">STS</text>
          <rect x="435" y="94" width="45" height="15" fill="var(--bg-panel)" stroke="none" />
          <line x1="440" y1="102" x2="475" y2="102" stroke="#EF4444" strokeWidth="2" />

          {/* Lower STS */}
          <rect x="430" y="200" width="55" height="46" rx="4" />
          <text x="457" y="215" fill="var(--text-main)" fontSize="8" textAnchor="middle" fontWeight="bold">STS</text>
          <rect x="435" y="222" width="45" height="15" fill="var(--bg-panel)" stroke="none" />
          <line x1="440" y1="230" x2="475" y2="230" stroke="#EF4444" strokeWidth="2" />

          {/* SACU unit attached to Lower STS */}
          <rect x="460" y="165" width="22" height="28" rx="2" fill="var(--text-sub)" stroke="var(--stroke-node)" />
          <text x="471" y="181" fill="var(--bg-node)" fontSize="6" textAnchor="middle" fontWeight="bold">SACU</text>
        </g>

        {/* 4. Booster Station Transformer */}
        <g transform="translate(660, 180)" stroke="var(--stroke-node)" strokeWidth="1.5">
          <rect x="0" y="0" width="50" height="50" rx="6" fill="var(--bg-node)" />
          <circle cx="18" cy="25" r="12" fill="none" stroke="#F59E0B" strokeWidth="1.5" />
          <circle cx="32" cy="25" r="12" fill="none" stroke="#EF4444" strokeWidth="1.5" />
          <path d="M 23 15 L 18 25 L 26 25 L 21 35" fill="none" stroke="#F59E0B" strokeWidth="1.5" strokeLinejoin="round" />
        </g>

        {/* 5. Utility Grid Connection Point */}
        <g transform="translate(925, 175)" stroke="var(--text-sub)" strokeWidth="1.5">
          <path d="M 15 50 L 25 5 M 25 5 L 35 50 M 12 18 L 38 18 M 8 28 L 42 28 M 20 5 L 30 5 M 20 18 L 25 5 L 30 18" fill="none" />
        </g>

        {/* 6. SEMS2000 & SPPC2000 Server Rack Cabinet */}
        <g transform="translate(630, 32)">
          <rect x="0" y="0" width="40" height="60" rx="3" fill="var(--bg-node)" stroke="var(--stroke-node)" strokeWidth="1.5" />
          <rect x="5" y="5" width="30" height="20" fill="var(--bg-panel)" />
          <path d="M 8 15 Q 12 5 15 15 T 25 15 T 32 15" stroke="#10B981" strokeWidth="1" fill="none" className="animate-pulse" />
          <text x="20" y="42" fill="var(--text-sub)" fontSize="7" fontWeight="bold" textAnchor="middle">SEMS</text>
          <text x="20" y="52" fill="var(--text-sub)" fontSize="7" fontWeight="bold" textAnchor="middle">2000</text>
        </g>
        
        <g transform="translate(720, 32)">
          <rect x="0" y="0" width="40" height="60" rx="3" fill="var(--bg-node)" stroke="var(--stroke-node)" strokeWidth="1.5" />
          <circle cx="20" cy="15" r="8" fill="var(--bg-panel)" stroke="none" />
          <circle cx="20" cy="15" r="4" className="phase-sppc-light" />
          <text x="20" y="42" fill="var(--text-sub)" fontSize="7" fontWeight="bold" textAnchor="middle">SPPC</text>
          <text x="20" y="52" fill="var(--text-sub)" fontSize="7" fontWeight="bold" textAnchor="middle">2000</text>
        </g>

        {/* DYNAMIC EXPLANATORY TEXT INSIDE SVG */}
        <g className="phase-terminal-flow" opacity="1">
          <rect x="250" y="270" width="500" height="42" rx="4" fill="var(--bg-node)" stroke="#3B82F6" strokeWidth="1" />
          <text x="265" y="286" fill="#3B82F6" fontSize="9" fontWeight="bold" className="uppercase">Stage A: Terminal Response (0 - 10 ms)</text>
          <text x="265" y="300" fill="var(--text-sub)" fontSize="8">PCS devices adjust active/reactive output spontaneously based on local measurements.</text>
        </g>
        
        <g className="phase-plant-flow" opacity="0">
          <rect x="250" y="270" width="500" height="42" rx="4" fill="var(--bg-node)" stroke="#EF4444" strokeWidth="1" />
          <text x="265" y="286" fill="#EF4444" fontSize="9" fontWeight="bold" className="uppercase">Stage B: Plant-Level Response (&gt; 10 ms)</text>
          <text x="265" y="300" fill="var(--text-sub)" fontSize="8">SPPC2000 controller balances grid sampling deviation and commands PCS adjustments.</text>
        </g>
      </svg>
    </div>
  );
}
