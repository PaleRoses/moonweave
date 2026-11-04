import {compileGraph} from './compile.mts';
import {freeze, nodeReferences, nodeType} from './algebra.mts';
import type {GraphSort, NodeKind} from './algebra.mts';
import type {GraphInput, GraphStructure} from './types.mts';

export interface ExecutionNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly sort: GraphSort;
  /** Original authored IDs whose result is this live representative. */
  readonly sources: readonly string[];
}
export interface ExecutionEdge {
  /** Dense topological node slots; every source precedes its target. */
  readonly source: number;
  readonly target: number;
  readonly port: string;
}
export interface GraphInspection {
  readonly nodes: readonly ExecutionNode[];
  readonly edges: readonly ExecutionEdge[];
  readonly output: number;
  /** Source nodes with no live representative, including unreachable definitions. */
  readonly eliminated: readonly string[];
  readonly statistics: Readonly<{
    authoredNodes: number;
    liveNodes: number;
    edges: number;
    /** Extra authored results mapped to an existing live representative. */
    aliases: number;
    /** Live values consumed by more than one input port. */
    reusedNodes: number;
  }>;
}

const inspections = new WeakMap<GraphStructure, GraphInspection>();

/** Inspect the actual compiled DAG. Metadata holds no graph payload or edit history. */
export function inspectGraph(input: GraphInput): GraphInspection {
  const plan=compileGraph(input),cached=inspections.get(plan.structure);
  if(cached)return cached;
  const slots=new Map(plan.nodes.map((node,index)=>[node.id,index]));
  const sources=plan.nodes.map(()=>[] as string[]),eliminated: string[]=[];
  for(const [source,representative] of Object.entries(plan.structure.sourceNodes)) {
    if(representative===null)eliminated.push(source);
    else sources[slots.get(representative)!].push(source);
  }
  const uses=plan.nodes.map(()=>0),edges: ExecutionEdge[]=[];
  const nodes=plan.nodes.map((node,index)=>{
    for(const {ref,key} of nodeReferences<string>(node)) {
      const source=slots.get(ref)!;
      uses[source]++;
      edges.push({source,target:index,port:key});
    }
    return {id:node.id,kind:node.kind,sort:nodeType(node),sources:sources[index]};
  });
  const result=freeze({nodes,edges,output:slots.get(plan.output)!,eliminated,
    statistics:{authoredNodes:plan.graph.nodes.length,liveNodes:nodes.length,edges:edges.length,
      aliases:sources.reduce((count,ids)=>count+Math.max(0,ids.length-1),0),
      reusedNodes:uses.filter(count=>count>1).length}});
  inspections.set(plan.structure,result);
  return result;
}
