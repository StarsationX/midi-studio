//! Magnitude at an attack, between its neighbors, and before the attack.
//! Both detectors measure the same contrast but use register-specific windows and gates.
pub(super) fn contrast(before: &[f32], after: &[f32], window: &[f32], omega: f64) -> (f64, f64, f64) {
    // Center and ±2 semitones. The fourth recurrence is the center before onset.
    let c = [1., 0.8908987181403393, 1.122462048309373].map(|r| 2. * (omega * r).cos());
    let (mut a, mut b) = ([0.; 4], [0.; 4]);
    for ((&x, &old), &w) in after.iter().zip(before).zip(window) {
        let last = a;
        let x = f64::from(x * w);
        for j in 0..3 { a[j] = x + c[j] * last[j] - b[j]; }
        a[3] = f64::from(old * w) + c[0] * last[3] - b[3];
        b = last;
    }
    let magnitude = |i: usize, c: f64| (a[i]*a[i] + b[i]*b[i] - c*a[i]*b[i]).max(0.).sqrt();
    (magnitude(0, c[0]), (magnitude(1, c[1]) + magnitude(2, c[2])) * 0.5, magnitude(3, c[0]))
}
