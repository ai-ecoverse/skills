// esbuild entry. Side effect only: SLICC's esbuild has no --global-name,
// so an IIFE bundle would otherwise drop the export. The page reads
// globalThis.__sliccMermaid after this script runs.
import mermaid from 'mermaid';

globalThis.__sliccMermaid = mermaid;
