import type {GraphInspection} from '@moonweave/surfaces/core';

const width=156,height=54,gapX=48,gapY=22,padding=22;

/** Stable layered placement of the compiler's topological slots; no layout engine. */
export function layoutGraph(graph: GraphInspection) {
  const depths=graph.nodes.map(()=>0);
  for(const edge of graph.edges)depths[edge.target]=Math.max(depths[edge.target],depths[edge.source]+1);
  const columns: number[][]=[];
  depths.forEach((depth,index)=>(columns[depth]??=[]).push(index));
  const rows=Math.max(...columns.map(column=>column.length));
  const positions=graph.nodes.map(()=>({x:0,y:0}));
  columns.forEach((column,depth)=>column.forEach((index,row)=>{
    positions[index]={x:padding+depth*(width+gapX),y:padding+((rows-column.length)/2+row)*(height+gapY)};
  }));
  return {positions,nodeWidth:width,nodeHeight:height,
    width:padding*2+columns.length*(width+gapX)-gapX,
    height:padding*2+rows*(height+gapY)-gapY};
}
