/** Stateless, independently mixed drawing streams.
 * Finalization breaks correlations between adjacent coordinates and properties.
 */
function drawingHash(x,y,seed=0){
  let h=Math.imul(x^0x9e3779b9,0x85ebca6b)^Math.imul(y^0xc2b2ae35,0x27d4eb2d)^seed;
  h=Math.imul(h^(h>>>16),0x7feb352d);
  h=Math.imul(h^(h>>>15),0x846ca68b);
  return ((h^(h>>>16))>>>0)/4294967296;
}

export {drawingHash};
