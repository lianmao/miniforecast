/**
 * Nelder-Mead simplex optimiser.
 *
 * The previous version of this tool tuned smoothing parameters by stepping
 * alpha from 0.05 to 0.95 in 0.1 increments. That is fast but coarse enough to
 * visibly change which model wins. Nelder-Mead converges to the actual optimum
 * with a few hundred cheap function evaluations, which is nothing in a browser.
 */

/**
 * Minimises `fn(x)` for x in R^n.
 *
 * @param {(x: number[]) => number} fn  objective; must return a finite number
 * @param {number[]} x0                 starting point
 * @param {{maxIter?: number, tol?: number, step?: number}} [options]
 * @returns {{x: number[], fx: number, iterations: number, converged: boolean}}
 */
export function nelderMead(fn, x0, options = {}) {
  const n = x0.length
  const maxIter = options.maxIter ?? 500
  const tol = options.tol ?? 1e-10
  const initialStep = options.step ?? 0.1

  const safe = (x) => {
    const v = fn(x)
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
  }

  // Build the initial simplex: x0 plus one perturbed vertex per dimension.
  let simplex = [{ x: x0.slice(), fx: safe(x0) }]
  for (let i = 0; i < n; i++) {
    const p = x0.slice()
    p[i] = clamp01(p[i] + (p[i] === 0 ? initialStep : initialStep * Math.max(1, Math.abs(p[i]))))
    simplex.push({ x: p, fx: safe(p) })
  }

  const alpha = 1 // reflection
  const gamma = 2 // expansion
  const rho = 0.5 // contraction
  const sigma = 0.5 // shrink

  let iterations = 0
  for (; iterations < maxIter; iterations++) {
    simplex.sort((a, b) => a.fx - b.fx)
    const best = simplex[0]
    const worst = simplex[n]
    const secondWorst = simplex[n - 1]

    // Converged when the simplex is small in both value and extent.
    const spread = Math.abs(worst.fx - best.fx)
    let extent = 0
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j < n; j++) extent = Math.max(extent, Math.abs(simplex[i].x[j] - best.x[j]))
    }
    if (spread < tol && extent < 1e-6) return { x: best.x, fx: best.fx, iterations, converged: true }

    // Centroid of everything except the worst vertex.
    const centroid = new Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j] / n
    }

    const reflected = combine(centroid, worst.x, alpha)
    const fr = safe(reflected)

    if (fr < secondWorst.fx && fr >= best.fx) {
      simplex[n] = { x: reflected, fx: fr }
      continue
    }

    if (fr < best.fx) {
      const expanded = combine(centroid, worst.x, gamma)
      const fe = safe(expanded)
      simplex[n] = fe < fr ? { x: expanded, fx: fe } : { x: reflected, fx: fr }
      continue
    }

    // Contraction
    const contracted = fr < worst.fx ? combine(centroid, worst.x, rho) : combine(centroid, worst.x, -rho)
    const fc = safe(contracted)
    if (fc < Math.min(fr, worst.fx)) {
      simplex[n] = { x: contracted, fx: fc }
      continue
    }

    // Shrink towards the best vertex.
    for (let i = 1; i <= n; i++) {
      const s = simplex[i].x.map((v, j) => best.x[j] + sigma * (v - best.x[j]))
      simplex[i] = { x: s, fx: safe(s) }
    }
  }

  simplex.sort((a, b) => a.fx - b.fx)
  return { x: simplex[0].x, fx: simplex[0].fx, iterations, converged: false }
}

function combine(centroid, worst, coeff) {
  return centroid.map((c, j) => c + coeff * (c - worst[j]))
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.min(0.999, Math.max(0.001, v))
}

/**
 * Convenience wrapper for optimising smoothing parameters, which must stay in
 * (0, 1). The objective receives already-clamped parameters.
 */
export function optimizeSmoothing(objective, x0, options = {}) {
  const wrapped = (x) => objective(x.map((v) => Math.min(0.999, Math.max(0.001, v))))
  const result = nelderMead(wrapped, x0, { maxIter: 400, tol: 1e-9, ...options })
  return {
    params: result.x.map((v) => Math.min(0.999, Math.max(0.001, v))),
    objective: result.fx,
    converged: result.converged,
  }
}
