import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface GraphNode {
  id: string;
  label: string;
  name: string;
  color: string;
  isVectorMatch: boolean;
  score?: number;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  label: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface VectorMatch {
  id: string;
  name: string;
  label: string;
  score: number;
}

interface ImageInfo {
  imageId: string;
  pageNumber: number;
  documentId: string;
  imagePath: string;
  description: string;
}

interface QueryResponse {
  answer: string;
  graph: GraphData;
  vectorMatches: VectorMatch[];
  images: ImageInfo[];
  stats: {
    vectorMatchCount: number;
    tripletCount: number;
    nodeCount: number;
    edgeCount: number;
    imageCount: number;
  };
}

function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const graphRef = useRef<any>(null);
  const [pendingZoomToFit, setPendingZoomToFit] = useState(false);

  const typeColorMapRef = useRef<Map<string, string>>(new Map());

  const getTypeColor = useCallback((rawLabel: unknown): string => {
    const label = String(rawLabel ?? "UNKNOWN").trim() || "UNKNOWN";
    const cached = typeColorMapRef.current.get(label);
    if (cached) return cached;

    // Deterministic hash -> HSL -> hex
    let hash = 0;
    for (let i = 0; i < label.length; i++) {
      hash = (hash * 31 + label.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const sat = 62;
    const light = 52;

    const hslToHex = (h: number, s: number, l: number) => {
      s /= 100;
      l /= 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      let r = 0;
      let g = 0;
      let b = 0;
      if (h < 60) {
        r = c;
        g = x;
      } else if (h < 120) {
        r = x;
        g = c;
      } else if (h < 180) {
        g = c;
        b = x;
      } else if (h < 240) {
        g = x;
        b = c;
      } else if (h < 300) {
        r = x;
        b = c;
      } else {
        r = c;
        b = x;
      }
      const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    };

    const color = hslToHex(hue, sat, light);
    typeColorMapRef.current.set(label, color);
    return color;
  }, []);

  const legend = useMemo(() => {
    const nodes = result?.graph?.nodes ?? [];
    const labels = new Set<string>();
    let hasVectorMatch = false;

    for (const node of nodes) {
      if (node?.isVectorMatch) hasVectorMatch = true;
      const label = String(node?.label ?? "UNKNOWN").trim() || "UNKNOWN";
      labels.add(label);
    }

    const items = Array.from(labels)
      .sort((a, b) => a.localeCompare(b))
      .map((label) => ({
        label,
        displayLabel: label === "UNKNOWN" ? "Unknown/Unclassified" : label,
        color: getTypeColor(label),
      }));

    return { hasVectorMatch, items };
  }, [result, getTypeColor]);

  const mainRef = useRef<HTMLDivElement | null>(null);
  const [leftWidthPct, setLeftWidthPct] = useState<number>(35);
  const draggingRef = useRef(false);

  const graphContainerRef = useRef<HTMLDivElement | null>(null);
  const [graphSize, setGraphSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const markdownAnswer = useMemo(() => {
    if (!result?.answer) return "";
    const images = result.images ?? [];
    if (images.length === 0) return result.answer;

    const imageById = new Map<string, ImageInfo>();
    for (const img of images) {
      if (img?.imageId) imageById.set(img.imageId, img);
    }

    const injected = new Set<string>();

    const inject = (text: string, imageId: string) => {
      const img = imageById.get(imageId);
      if (!img?.imagePath || injected.has(imageId)) return text;
      injected.add(imageId);
      const title = `Image ID: ${imageId}`;
      return `${text}\n\n![${title}](${img.imagePath})\n`;
    };

    let out = result.answer;

    // Preferred format: ![caption](image:<IMAGE_ID>)
    // Rewrite image:<id> to the actual served path (/images/...) so the prose can stay clean.
    out = out.replace(/(!\[[^\]]*\]\()image:([A-Za-z0-9_.-]+)(\))/g, (match, pre, id, post) => {
      const img = imageById.get(String(id));
      if (!img?.imagePath) return match;
      return `${String(pre)}${img.imagePath}${String(post)}`;
    });

    // Also support normal Markdown links: [something](image:<IMAGE_ID>)
    out = out.replace(/(\]\()image:([A-Za-z0-9_.-]+)(\))/g, (match, pre, id, post) => {
      const img = imageById.get(String(id));
      if (!img?.imagePath) return match;
      return `${String(pre)}${img.imagePath}${String(post)}`;
    });

    out = out.replace(/Image ID:\s*([A-Za-z0-9_.-]+)/g, (match, id) => inject(match, String(id)));

    out = out.replace(/\(ID:\s*([A-Za-z0-9_.-]+)\)/g, (match, id, offset, full) => {
      const prefix = String(full).slice(Math.max(0, Number(offset) - 40), Number(offset));
      if (!/image/i.test(prefix)) return match;
      return inject(match, String(id));
    });

    return out;
  }, [result]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const el = mainRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      const clamped = Math.max(22, Math.min(60, pct));
      setLeftWidthPct(clamped);
    };

    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [getTypeColor]);

  useEffect(() => {
    const el = graphContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const cr = entry?.contentRect;
      if (!cr) return;
      setGraphSize({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleQuery = useCallback(async () => {
    if (!query.trim()) return;
    
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Query failed');
      }
      
      const data: QueryResponse = await response.json();
      setResult(data);
      setPendingZoomToFit(true);
      
      // Center graph after data loads
      setTimeout(() => {
        if (graphRef.current) {
          graphRef.current.zoomToFit(400, 50);
        }
      }, 100);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleZoomIn = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    const k = g.zoom();
    g.zoom(k * 1.2, 200);
  }, []);

  const handleZoomOut = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    const k = g.zoom();
    g.zoom(k / 1.2, 200);
  }, []);

  const handleZoomToFit = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    g.zoomToFit(600, 60);
  }, []);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleQuery();
    }
  }, [handleQuery]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  // Custom node rendering
  const nodeCanvasObject = useCallback((node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const label = node.name || node.id;
    const fontSize = 12 / globalScale;
    ctx.font = `${fontSize}px Sans-Serif`;
    
    const textWidth = ctx.measureText(label).width;
    const nodeSize = node.isVectorMatch ? 8 : 6;
    
    // Draw node circle
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, nodeSize, 0, 2 * Math.PI);
    ctx.fillStyle = getTypeColor(node.label);
    ctx.fill();
    
    // Draw highlight ring for vector matches
    if (node.isVectorMatch) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }
    
    // Draw label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(label, node.x!, node.y! + nodeSize + fontSize);
  }, []);

  // Custom link rendering
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const start = link.source;
    const end = link.target;
    
    if (typeof start !== 'object' || typeof end !== 'object') return;
    
    // Draw line
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1 / globalScale;
    ctx.stroke();
    
    // Draw arrow
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const arrowLength = 6 / globalScale;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(
      midX - arrowLength * Math.cos(angle - Math.PI / 6),
      midY - arrowLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      midX - arrowLength * Math.cos(angle + Math.PI / 6),
      midY - arrowLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fillStyle = '#475569';
    ctx.fill();
    
    // Draw label
    const fontSize = 10 / globalScale;
    ctx.font = `${fontSize}px Sans-Serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#94a3b8';
    
    // Offset label slightly
    const labelX = midX + 10 / globalScale * Math.cos(angle + Math.PI / 2);
    const labelY = midY + 10 / globalScale * Math.sin(angle + Math.PI / 2);
    ctx.fillText(link.label, labelX, labelY);
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700 px-6 py-4">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <span className="text-3xl">🔮</span>
          KG-RAG Visualizer
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Query your knowledge graph and visualize the retrieval process
        </p>
      </header>

      {/* Query Input */}
      <div className="bg-slate-800 border-b border-slate-700 px-6 py-4">
        <div className="flex gap-4 max-w-4xl">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask a question about your documents..."
            className="flex-1 px-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          />
          <button
            onClick={handleQuery}
            disabled={loading || !query.trim()}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Searching...
              </>
            ) : (
              <>
                <span>🔍</span>
                Search
              </>
            )}
          </button>
        </div>
        
        {error && (
          <div className="mt-3 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-200 text-sm">
            ❌ {error}
          </div>
        )}
      </div>

      {/* Main Content */}
      <div ref={mainRef} className="flex-1 flex overflow-hidden">
        {/* Left Panel - Answer */}
        <div className="border-r border-slate-700 flex flex-col" style={{ width: `${leftWidthPct}%` }}>
          {/* Answer Section */}
          <div className="flex-1 p-6 overflow-auto">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <span>🤖</span> Answer
            </h2>
            
            {result ? (
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {markdownAnswer}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-slate-500 italic">
                Ask a question to see the answer and knowledge graph visualization.
              </p>
            )}
          </div>

          {/* Stats Section */}
          {result && (
            <div className="border-t border-slate-700 p-4 bg-slate-800/50">
              <h3 className="text-sm font-semibold text-slate-400 mb-3">📊 Retrieval Stats</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="bg-slate-700/50 rounded p-2">
                  <div className="text-slate-400">Vector Matches</div>
                  <div className="text-xl font-bold text-blue-400">{result.stats.vectorMatchCount}</div>
                </div>
                <div className="bg-slate-700/50 rounded p-2">
                  <div className="text-slate-400">Triplets</div>
                  <div className="text-xl font-bold text-green-400">{result.stats.tripletCount}</div>
                </div>
                <div className="bg-slate-700/50 rounded p-2">
                  <div className="text-slate-400">Nodes</div>
                  <div className="text-xl font-bold text-purple-400">{result.stats.nodeCount}</div>
                </div>
                <div className="bg-slate-700/50 rounded p-2">
                  <div className="text-slate-400">Edges</div>
                  <div className="text-xl font-bold text-orange-400">{result.stats.edgeCount}</div>
                </div>
              </div>
            </div>
          )}

          {/* Vector Matches */}
          {result && result.vectorMatches.length > 0 && (
            <div className="border-t border-slate-700 p-4 bg-slate-800/50 max-h-48 overflow-auto">
              <h3 className="text-sm font-semibold text-slate-400 mb-3">🎯 Vector Matches</h3>
              <div className="space-y-2">
                {result.vectorMatches.map((match, i) => (
                  <div key={match.id} className="flex items-center gap-2 text-sm">
                    <span className="text-yellow-400 font-mono">{(match.score * 100).toFixed(1)}%</span>
                    <span className="px-2 py-0.5 bg-slate-600 rounded text-xs text-slate-300">{match.label}</span>
                    <span className="text-white truncate">{match.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Images Found in Context */}
          {result && result.images && result.images.length > 0 && (
            <div className="border-t border-slate-700 p-4 bg-slate-800/50 overflow-auto" style={{ maxHeight: '400px' }}>
              <h3 className="text-sm font-semibold text-slate-400 mb-3">🖼️ Images in Context ({result.images.length})</h3>
              <div className="space-y-4">
                {result.images.map((img) => (
                  <div key={img.imageId} className="bg-slate-700/50 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-2">
                      <span className="font-mono">{img.imageId}</span>
                      <span className="mx-2">•</span>
                      <span>Page {img.pageNumber}</span>
                      <span className="mx-2">•</span>
                      <span>{img.documentId}</span>
                    </div>
                    {img.imagePath && (
                      <img 
                        src={img.imagePath} 
                        alt={img.description.slice(0, 100)}
                        className="w-full rounded border border-slate-600 mb-2 cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() => window.open(img.imagePath, '_blank')}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                    <p className="text-xs text-slate-300 line-clamp-3">{img.description.replace(/^\[Image on page \d+\]\n?/, '')}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Draggable Splitter */}
        <div
          className="bg-slate-700/60 hover:bg-slate-600 transition-colors"
          style={{ width: 8, cursor: 'col-resize', flexShrink: 0, zIndex: 50 }}
          onMouseDown={() => {
            draggingRef.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
          title="Drag to resize"
        />

        {/* Right Panel - Graph */}
        <div ref={graphContainerRef} className="flex-1 relative bg-slate-950 overflow-hidden">
          {result && result.graph.nodes.length > 0 ? (
            <>
              <ForceGraph2D
                ref={graphRef}
                graphData={result.graph}
                nodeCanvasObject={nodeCanvasObject}
                linkCanvasObject={linkCanvasObject}
                onNodeClick={handleNodeClick}
                onEngineStop={() => {
                  if (!pendingZoomToFit) return;
                  setPendingZoomToFit(false);
                  if (graphRef.current) {
                    graphRef.current.zoomToFit(700, 60);
                  }
                }}
                nodeRelSize={6}
                linkDirectionalArrowLength={0}
                backgroundColor="#0f172a"
                width={graphSize.width || undefined}
                height={graphSize.height || undefined}
              />

              <div className="absolute top-4 left-4 bg-slate-800/90 rounded-lg p-2 text-sm flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleZoomIn}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                  title="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={handleZoomOut}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                  title="Zoom out"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={handleZoomToFit}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                  title="Fit graph to view"
                >
                  Fit
                </button>
              </div>
              
              {/* Legend */}
              <div className="absolute top-4 right-4 bg-slate-800/90 rounded-lg p-4 text-sm">
                <h4 className="font-semibold text-white mb-2">Legend</h4>
                <div className="space-y-1">
                  {legend.hasVectorMatch && (
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-yellow-400 ring-2 ring-yellow-400"></div>
                      <span className="text-slate-300">Vector Match</span>
                    </div>
                  )}

                  {legend.items.map((item) => (
                    <div key={item.label} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }}></div>
                      <span className="text-slate-300">{item.displayLabel}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Selected Node Info */}
              {selectedNode && (
                <div className="absolute bottom-4 left-4 bg-slate-800/90 rounded-lg p-4 max-w-sm">
                  <h4 className="font-semibold text-white mb-2 flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: getTypeColor(selectedNode.label) }}></div>
                    {selectedNode.name}
                  </h4>
                  <div className="text-sm text-slate-400 space-y-1">
                    <div><span className="text-slate-500">Type:</span> {selectedNode.label}</div>
                    <div><span className="text-slate-500">ID:</span> <span className="font-mono text-xs">{selectedNode.id}</span></div>
                    {selectedNode.isVectorMatch && (
                      <div className="text-yellow-400">⭐ Vector Match (score: {((selectedNode.score || 0) * 100).toFixed(1)}%)</div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500">
              <div className="text-center">
                <div className="text-6xl mb-4">🕸️</div>
                <p>Knowledge graph will appear here</p>
                <p className="text-sm mt-2">Enter a query to visualize the retrieval</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
