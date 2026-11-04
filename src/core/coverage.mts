import type {ScalarExpression} from './algebra.mts';
type ScalarInput = number | ScalarExpression;
import {ownExpression, scalar} from './graph.mts';

const asScalar = (value: ScalarInput): ScalarExpression => typeof value === 'number' ? scalar.constant(value) : value;

/**
 * Smooth coverage algebra, for inputs in [0,1]. No hidden clamp or smoothstep.
 *
 * intersect(a,b) = ab               subtract(a,b) = a(1-b)
 * union(a,b) = a + (1-a)b           complement(a) = 1-a
 *
 * Union and intersection are commutative/associative over the reals, but not
 * idempotent. Floating-point evaluation retains the authored order. The union
 * form avoids subtracting two almost-equal ones when coverage is small.
 */
export const coverage = Object.freeze({
  intersect: (a: ScalarInput, b: ScalarInput): ScalarExpression => scalar.multiply(a, b),
  union(a: ScalarInput, b: ScalarInput): ScalarExpression {
    const left = asScalar(a), right = asScalar(b);
    // Own the whole composition once: repeated raw operands and descendants
    // must remain shared, just as they are in a single scalar constructor.
    return ownExpression({kind: 'add', a: left,
      b: {kind: 'multiply', a: {kind: 'complement', input: left}, b: right}});
  },
  subtract(a: ScalarInput, b: ScalarInput): ScalarExpression {
    return ownExpression({kind: 'multiply', a: asScalar(a),
      b: {kind: 'complement', input: asScalar(b)}});
  },
  complement: (input: ScalarInput): ScalarExpression => scalar.complement(input),
});
