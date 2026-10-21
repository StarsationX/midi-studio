/* SoX Resampler Library      Copyright (c) 2007-16 robs@users.sourceforge.net
 * Licence for this file: LGPL v2.1                  See LICENCE for details.
 *
 * Hand-written equivalent of the soxr-config.h that libsoxr's CMake generates
 * for python-soxr 0.5.0.post1 on Windows x64 / MSVC (WITH_VR32 OFF, OpenMP
 * OFF, everything else at its default), so forge-rs resamples with the same
 * engines (HQ -> cr32s + pffft) as soxr.resample() in the Python path. */

#if !defined soxr_config_included
#define soxr_config_included

#define AVCODEC_FOUND 0
#define AVUTIL_FOUND 0
#define WITH_PFFFT 1

#define HAVE_FENV_H 1
#define HAVE_STDBOOL_H 1
#define HAVE_STDINT_H 1
#define HAVE_GETAUXVAL 0
#define HAVE_LRINT 1
#define HAVE_BIGENDIAN 0

#define WITH_CR32 1
#define WITH_CR32S 1
#define WITH_CR64 1
#define WITH_CR64S 1
#define WITH_VR32 0

#define WITH_HI_PREC_CLOCK 1
#define WITH_FLOAT_STD_PREC_CLOCK 0
#define WITH_DEV_TRACE 1

#endif
