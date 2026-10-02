import { useState, useEffect } from 'react';
import {
  BMWModeKey,
  BMWAdjustment,
  loadBMWAdjustment,
  saveBMWAdjustment,
  DEFAULT_BMW_ADJUSTMENTS,
  subscribeBMWAdjustment,
} from '@/utils/bmwCar';

interface BMWAdjustmentModalProps {
  mode: BMWModeKey;
  isOpen: boolean;
  onClose: () => void;
}

const MODE_LABELS: Record<BMWModeKey, { title: string; subtitle: string; color: string }> = {
  pro_drift: {
    title: 'PRO DRIFT 3D',
    subtitle: 'Pengaturan Dimensi & Ketinggian Body BMW GLB (Skala Standar)',
    color: 'border-yellow-400 text-yellow-400 bg-yellow-400/10',
  },
  sakura_rc: {
    title: 'SAKURA RC PRO',
    subtitle: 'Pengaturan Dimensi & Ketinggian Body BMW GLB (Skala 1:10 RC)',
    color: 'border-pink-400 text-pink-400 bg-pink-400/10',
  },
  ebisu: {
    title: 'EBISU CIRCUIT',
    subtitle: 'Pengaturan Dimensi & Ketinggian Body BMW GLB (Skala Touge Mountain)',
    color: 'border-orange-400 text-orange-400 bg-orange-400/10',
  },
};

export function BMWAdjustmentModal({ mode, isOpen, onClose }: BMWAdjustmentModalProps) {
  const [adj, setAdj] = useState<BMWAdjustment>(() => loadBMWAdjustment(mode));

  useEffect(() => {
    setAdj(loadBMWAdjustment(mode));
    return subscribeBMWAdjustment(mode, (newAdj) => {
      setAdj(newAdj);
    });
  }, [mode]);

  if (!isOpen) return null;

  const defaultAdj = DEFAULT_BMW_ADJUSTMENTS[mode];
  const meta = MODE_LABELS[mode];

  const updateField = (field: keyof BMWAdjustment, value: number) => {
    const updated = { ...adj, [field]: value };
    setAdj(updated);
    saveBMWAdjustment(mode, updated);
  };

  const resetToDefault = () => {
    const def = { ...defaultAdj };
    setAdj(def);
    saveBMWAdjustment(mode, def);
  };

  // Dynamic slider limits relative to default
  const lengthMin = Number((defaultAdj.length * 0.6).toFixed(2));
  const lengthMax = Number((defaultAdj.length * 1.6).toFixed(2));
  const widthMin = Number((defaultAdj.width * 0.6).toFixed(2));
  const widthMax = Number((defaultAdj.width * 1.6).toFixed(2));
  const heightMin = Number((defaultAdj.height * 0.5).toFixed(2));
  const heightMax = Number((defaultAdj.height * 1.8).toFixed(2));
  const offsetMin = Number((defaultAdj.offsetY - 0.4).toFixed(2));
  const offsetMax = Number((defaultAdj.offsetY + 0.6).toFixed(2));

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg rounded-3xl bg-neutral-900 border-2 border-neutral-700/80 p-5 sm:p-6 shadow-2xl text-white space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-neutral-800 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">📐</span>
              <h2 className="text-lg sm:text-xl font-black tracking-tight">
                ADJUST BODY BMW GLB
              </h2>
              <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${meta.color}`}>
                {meta.title}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mt-1">{meta.subtitle}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center text-neutral-400 hover:text-white transition cursor-pointer text-sm font-bold"
          >
            ✕
          </button>
        </div>

        {/* Sliders */}
        <div className="space-y-4">
          {/* 1. PANJANG */}
          <div className="space-y-1.5 p-3 rounded-2xl bg-neutral-950/60 border border-neutral-800">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-neutral-300">Panjang Body (Length)</span>
              <span className="font-mono text-amber-300 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-500/20">
                {adj.length.toFixed(2)} m
              </span>
            </div>
            <input
              type="range"
              min={lengthMin}
              max={lengthMax}
              step={0.01}
              value={adj.length}
              onChange={(e) => updateField('length', parseFloat(e.target.value))}
              className="w-full accent-amber-400 cursor-pointer h-2 bg-neutral-800 rounded-lg"
            />
            <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
              <span>{lengthMin} m</span>
              <span className="text-neutral-400">Default: {defaultAdj.length.toFixed(2)} m</span>
              <span>{lengthMax} m</span>
            </div>
          </div>

          {/* 2. LEBAR */}
          <div className="space-y-1.5 p-3 rounded-2xl bg-neutral-950/60 border border-neutral-800">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-neutral-300">Lebar Body (Width)</span>
              <span className="font-mono text-cyan-300 bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-500/20">
                {adj.width.toFixed(2)} m
              </span>
            </div>
            <input
              type="range"
              min={widthMin}
              max={widthMax}
              step={0.01}
              value={adj.width}
              onChange={(e) => updateField('width', parseFloat(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer h-2 bg-neutral-800 rounded-lg"
            />
            <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
              <span>{widthMin} m</span>
              <span className="text-neutral-400">Default: {defaultAdj.width.toFixed(2)} m</span>
              <span>{widthMax} m</span>
            </div>
          </div>

          {/* 3. TINGGI */}
          <div className="space-y-1.5 p-3 rounded-2xl bg-neutral-950/60 border border-neutral-800">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-neutral-300">Tinggi Body (Height)</span>
              <span className="font-mono text-emerald-300 bg-emerald-400/10 px-2 py-0.5 rounded border border-emerald-500/20">
                {adj.height.toFixed(2)} m
              </span>
            </div>
            <input
              type="range"
              min={heightMin}
              max={heightMax}
              step={0.01}
              value={adj.height}
              onChange={(e) => updateField('height', parseFloat(e.target.value))}
              className="w-full accent-emerald-400 cursor-pointer h-2 bg-neutral-800 rounded-lg"
            />
            <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
              <span>{heightMin} m</span>
              <span className="text-neutral-400">Default: {defaultAdj.height.toFixed(2)} m</span>
              <span>{heightMax} m</span>
            </div>
          </div>

          {/* 4. LETAK KETINGGIAN (GROUND / RIDE HEIGHT OFFSET) */}
          <div className="space-y-1.5 p-3 rounded-2xl bg-neutral-950/60 border border-neutral-800">
            <div className="flex items-center justify-between text-xs font-bold">
              <span className="text-neutral-300">Letak Ketinggian (Ride Height Offset Y)</span>
              <span className="font-mono text-purple-300 bg-purple-400/10 px-2 py-0.5 rounded border border-purple-500/20">
                {adj.offsetY >= 0 ? `+${adj.offsetY.toFixed(2)}` : adj.offsetY.toFixed(2)} m
              </span>
            </div>
            <input
              type="range"
              min={offsetMin}
              max={offsetMax}
              step={0.01}
              value={adj.offsetY}
              onChange={(e) => updateField('offsetY', parseFloat(e.target.value))}
              className="w-full accent-purple-400 cursor-pointer h-2 bg-neutral-800 rounded-lg"
            />
            <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
              <span>{offsetMin} m (Ceper)</span>
              <span className="text-neutral-400">Default: {defaultAdj.offsetY.toFixed(2)} m</span>
              <span>{offsetMax} m (Tinggi)</span>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-2 border-t border-neutral-800">
          <button
            onClick={resetToDefault}
            className="px-3.5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
          >
            <span>🔄</span>
            <span>Reset ke Default</span>
          </button>

          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-orange-400 hover:from-amber-300 hover:to-orange-300 text-neutral-950 text-xs font-black uppercase tracking-wider transition shadow-lg cursor-pointer"
          >
            Selesai &amp; Simpan
          </button>
        </div>
      </div>
    </div>
  );
}
