import {For, createMemo, createSignal} from 'solid-js';
import {inspectGraph} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import {layoutGraph} from '../graph-layout.mts';
import './execution-graph.css';

/** A projection of the compiled program; authored JSON remains the editable source. */
export function ExecutionGraph(props: {editor: Editor}) {
  const graph=createMemo(()=>inspectGraph(props.editor.graph()));
  const layout=createMemo(()=>layoutGraph(graph()));
  const [selection,setSelection]=createSignal('');
  const selected=createMemo(()=>{
    const index=graph().nodes.findIndex(node=>node.id===selection());
    return index<0?graph().output:index;
  });
  const node=()=>graph().nodes[selected()];
  const inputs=()=>graph().edges.filter(edge=>edge.target===selected());
  const consumers=()=>graph().edges.filter(edge=>edge.source===selected());
  const connected=(index: number)=>index===selected()||graph().edges.some(edge=>
    edge.source===selected()&&edge.target===index||edge.target===selected()&&edge.source===index);
  const path=(source: number,target: number)=>{
    const {positions,nodeWidth,nodeHeight}=layout(),a=positions[source],b=positions[target];
    const x=a.x+nodeWidth,y=a.y+nodeHeight/2,end=b.y+nodeHeight/2,middle=(x+b.x)/2;
    return `M ${x} ${y} C ${middle} ${y}, ${middle} ${end}, ${b.x} ${end}`;
  };
  return <section class="execution-graph" aria-labelledby="execution-title">
    <div class="execution-heading"><div><span class="eyebrow">THE LIVE PROGRAM</span>
      <h3 id="execution-title">One result. Shared wherever it belongs.</h3></div>
      <p id="execution-statistics">{graph().statistics.authoredNodes} authored · {graph().statistics.liveNodes} live · {graph().statistics.reusedNodes} reused</p>
    </div>
    <p class="execution-copy">Follow the connections from fields to surface. Select a node to see its named sources and consumers. Values stay editable in the graph above.</p>
    <div class="execution-canvas" tabindex="0" aria-label="Execution graph, scroll to explore">
      <svg width={layout().width} height={layout().height} viewBox={`0 0 ${layout().width} ${layout().height}`} aria-label="Compiled surface connections">
        <For each={graph().edges}>{edge=><path d={path(edge.source,edge.target)} class="execution-edge"
          classList={{active:edge.source===selected()||edge.target===selected()}}/>}</For>
        <For each={graph().nodes}>{(item,index)=><g role="button" tabindex="0"
          aria-label={`${item.id}, ${item.kind}, ${item.sources.length} authored sources`}
          aria-pressed={index()===selected()} transform={`translate(${layout().positions[index()].x} ${layout().positions[index()].y})`}
          class="execution-node" classList={{selected:index()===selected(),connected:connected(index()),output:index()===graph().output}}
          onClick={()=>setSelection(item.id)} onKeyDown={event=>{
            if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelection(item.id);}
          }}>
          <rect width={layout().nodeWidth} height={layout().nodeHeight} rx="5"/>
          <text x="12" y="21">{item.kind}<tspan x={layout().nodeWidth-12} text-anchor="end" class="execution-id">{item.id}</tspan></text>
          <text x="12" y="39" class="execution-sort">{item.sort}{item.sources.length>1?` · ${item.sources.length} sources`:''}{index()===graph().output?' · output':''}</text>
        </g>}</For>
      </svg>
    </div>
    <div class="execution-details" aria-live="polite">
      <div><h4>{node().id} · {node().kind}</h4><p>Authored: {node().sources.length?node().sources.join(', '):'compiled literal'}</p></div>
      <div><h4>Inputs</h4><p>{inputs().length?inputs().map(edge=>`${edge.port} ← ${graph().nodes[edge.source].id}`).join(' · '):'Source value'}</p></div>
      <div><h4>Consumers</h4><p>{consumers().length?consumers().map(edge=>`${graph().nodes[edge.target].id}.${edge.port}`).join(' · '):'Final surface'}</p></div>
    </div>
    <p class="execution-copy">{graph().statistics.aliases} authored results share a live representative. {graph().eliminated.length} authored nodes have no live representative.
      {graph().eliminated.length?` Retained for editing: ${graph().eliminated.join(', ')}.`:''}</p>
  </section>;
}
