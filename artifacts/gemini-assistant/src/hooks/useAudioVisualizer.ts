import { useState, useEffect, useRef } from "react";

export function useAudioVisualizer(active: boolean) {
  const [bars, setBars] = useState<number[]>(Array(20).fill(0.1));
  const animFrameRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setBars(Array(20).fill(0.1));
      return;
    }

    let cancelled = false;

    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        audioCtxRef.current = new AudioContext();
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 64;
        sourceRef.current = audioCtxRef.current.createMediaStreamSource(stream);
        sourceRef.current.connect(analyserRef.current);

        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);

        const animate = () => {
          if (!analyserRef.current || cancelled) return;
          analyserRef.current.getByteFrequencyData(dataArray);
          const newBars = Array.from({ length: 20 }, (_, i) => {
            const idx = Math.floor((i / 20) * dataArray.length);
            return Math.max(0.05, dataArray[idx] / 255);
          });
          setBars(newBars);
          animFrameRef.current = requestAnimationFrame(animate);
        };
        animate();
      } catch {
        const animate = () => {
          if (cancelled) return;
          const newBars = Array(20)
            .fill(0)
            .map(() => 0.05 + Math.random() * 0.3);
          setBars(newBars);
          animFrameRef.current = requestAnimationFrame(animate);
        };
        animate();
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [active]);

  return bars;
}
