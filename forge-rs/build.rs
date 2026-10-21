// Builds the vendored libsoxr (the exact sources python-soxr 0.5.0.post1
// bundles) with the same engine set its CMake build enables: cr32/cr32s/cr64
// + cr64s (AVX), PFFFT for the SIMD DFT, no VR32, no OpenMP.
fn main() {
    let src = "vendor/libsoxr/src";
    let cfg = "vendor/libsoxr/config";
    println!("cargo:rerun-if-changed=vendor");

    let common = |b: &mut cc::Build| {
        b.include(cfg)
            .include(src)
            .define("SOXR_LIB", None)
            .define("_USE_MATH_DEFINES", None)
            .define("_CRT_SECURE_NO_WARNINGS", None)
            .opt_level(2)
            .warnings(false);
    };

    let mut main = cc::Build::new();
    common(&mut main);
    for f in [
        "soxr", "data-io", "dbesi0", "filter", "fft4g64", "cr", "cr32", "fft4g32", "cr64",
        "cr32s", "pffft32s", "util32s",
    ] {
        main.file(format!("{src}/{f}.c"));
    }
    main.file("vendor/forge_soxr.c");
    main.compile("forge_soxr");

    // Per-file SIMD64 flags, as libsoxr's CMake sets them (MSVC: /arch:AVX).
    let mut avx = cc::Build::new();
    common(&mut avx);
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("msvc") {
        avx.flag("/arch:AVX");
    } else {
        avx.flag("-mavx");
    }
    for f in ["cr64s", "pffft64s", "util64s"] {
        avx.file(format!("{src}/{f}.c"));
    }
    avx.compile("forge_soxr_avx");
}
