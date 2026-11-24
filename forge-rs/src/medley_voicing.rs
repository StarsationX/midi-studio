//! Compare the same slice of the recording and the sampled keys. A sparse
//! piano arrangement cannot reproduce an entire band: constrain the balance
//! of pitches it can play, not every spectral peak in the recording.
use super::{reference::Voice, Fit, EPS, NONE, PHRASE, RATE};
use realfft::{num_complex::Complex32, RealFftPlanner};
use std::{ops::Range, sync::LazyLock};

const N: usize = 1536;
const PITCHES: usize = 68; // MIDI 29..96, including partials of low bass notes.
const HZ: f64 = RATE / N as f64;
const LEVEL: usize = PHRASE + 6;
static WINDOW: LazyLock<[f32; N]> = LazyLock::new(|| std::array::from_fn(|i|
    0.5 - 0.5*(std::f32::consts::TAU*i as f32/(N-1) as f32).cos()));
static FILTERS: LazyLock<[Range<usize>; PITCHES]> = LazyLock::new(|| std::array::from_fn(|i| {
    let f = 440.*2_f64.powf((i as f64+29.-69.)/12.) / HZ;
    let lo = (f*2_f64.powf(-1./24.)).ceil() as usize;
    lo..((f*2_f64.powf(1./24.)).ceil() as usize).max(lo+1)
}));
#[derive(Clone)]
struct Spectrum { pitches: [f32; PITCHES], bands: [f32; 3] }
impl Spectrum {
    fn read(freq: &[Complex32]) -> Self {
        let power: [f32; N/2+1] = std::array::from_fn(|i| freq[i].norm_sqr());
        let band = |lo: f64, hi: f64| power[(lo/HZ).ceil() as usize..(hi/HZ).ceil() as usize].iter().sum();
        Self { pitches: std::array::from_fn(|i| power[FILTERS[i].clone()].iter().copied().fold(0., f32::max)),
            bands: [band(95.,2400.),band(40.,170.),band(270.,1600.)] }
    }
}

// The fit needs positive energy contributions to vary a key's velocity. Correct
// their target for the difference between adding powers and mixing actual keys.
fn target(src: f32, separate: f32, together: f32) -> f32 {
    src / (0.45 + 0.55 * (together/separate.max(EPS)).clamp(0.1,5.))
}
fn constrain(fit: &mut Fit, voices: &[(usize,Spectrum)], src: &Spectrum, mixed: &Spectrum) {
    let mut sum = Spectrum { pitches: [0.; PITCHES], bands: [0.;3] };
    for (_,s) in voices {
        for (x,y) in sum.bands.iter_mut().zip(&s.bands) { *x += y; }
        for (x,y) in sum.pitches.iter_mut().zip(&s.pitches) { *x += y; }
    }
    let mut middle = NONE;
    for i in [0,2,1] {
        if src.bands[i] <= EPS || sum.bands[i] <= EPS { continue; }
        let row = fit.add(target(src.bands[i],sum.bands[i],mixed.bands[i]), [8000.,2400.,1200.][i],
            LEVEL+i, if i==1 { middle } else { NONE }, voices.iter().map(|(j,s)| (*j,s.bands[i])));
        if i==2 { middle=row; }
    }
    if voices.len()<2 { return; }
    let played_peak = sum.pitches.iter().copied().fold(0., f32::max);
    let source_peak = src.pitches.iter().copied().fold(0., f32::max);
    let mut bins = [0; PITCHES];
    let (mut count, mut observed, mut predicted, mut reference) = (0,0.,0.,0.);
    for i in 0..PITCHES {
        let (s,p) = (src.pitches[i],sum.pitches[i]);
        if p <= 0.009*played_peak || s <= 0.003*source_peak && p <= 0.06*played_peak { continue; }
        bins[count]=i; count+=1; observed+=s; predicted+=p;
        reference+=target(s,p,mixed.pitches[i]);
    }
    if count<2 || observed<=EPS || predicted<=EPS || reference<=EPS { return; }
    let bins = &bins[..count];
    let whole = fit.add(reference,0.,NONE,NONE,voices.iter().map(|(j,s)|(*j,bins.iter().map(|&i|s.pitches[i]).sum())));
    for &i in bins {
        let (s,p) = (src.pitches[i],sum.pitches[i]);
        let weight = 22000. * ((s/observed)*(p/predicted)).sqrt();
        fit.add(target(s.max(0.002*source_peak),p,mixed.pitches[i]),weight,NONE,whole,
            voices.iter().map(|(j,s)| (*j,s.pitches[i])));
    }
}

pub(super) fn measure(fit: &mut Fit, voices: &[Voice], recording: &[f32], piano: &[(f64,f64)]) {
    if recording.len() < N || voices.is_empty() { return; }
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N);
    let (mut x, mut freq, mut scratch) = (fft.make_input_vec(),fft.make_output_vec(),fft.make_scratch_vec());
    let mut field = fft.make_output_vec();
    let (mut next,mut section) = (0,0);
    let mut active = Vec::<usize>::new();
    let mut components = Vec::new();
    for at in (0..=recording.len()-N).step_by(N/3) {
        let (start,end) = (at as f64/RATE,(at+N) as f64/RATE);
        while section<piano.len() && piano[section].1<=start { section+=1; }
        if piano.get(section).is_some_and(|s| s.0<end) { continue; }
        let at = at as isize;
        active.retain(|&j| voices[j].end>at);
        while next<voices.len() && voices[next].start<at+N as isize {
            if voices[next].end>at { active.push(next); }
            next+=1;
        }
        if active.is_empty() { if next==voices.len() {break;} continue; }
        for ((y,w),s) in x.iter_mut().zip(WINDOW.iter()).zip(&recording[at as usize..]) { *y=w*s; }
        fft.process_with_scratch(&mut x,&mut freq,&mut scratch).expect("fixed piano analysis window");
        let src = Spectrum::read(&freq);
        if src.bands[0]<1e-6 { continue; }
        components.clear();
        if active.len()>1 { field.fill(Default::default()); }
        for &j in &active {
            x.fill(0.);
            voices[j].window(at,N,|i,y| x[i]=y*WINDOW[i]);
            fft.process_with_scratch(&mut x,&mut freq,&mut scratch).expect("fixed piano analysis window");
            if active.len()>1 { for (z,&y) in field.iter_mut().zip(&freq) { *z+=y; } }
            components.push((j,Spectrum::read(&freq)));
        }
        if components.len()==1 { constrain(fit,&components,&src,&components[0].1); }
        else { constrain(fit,&components,&src,&Spectrum::read(&field)); }
    }
}
