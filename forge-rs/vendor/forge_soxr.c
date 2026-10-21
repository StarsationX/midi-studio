/* forge-rs shim over libsoxr: a line-for-line C port of python-soxr 0.5.0's
 * csoxr_divide_proc<float>() (src/soxr_ext.cpp), which is what
 * soxr.resample(x, in_rate, out_rate) runs for float32 input. Same io spec,
 * same quality spec, same chunking, same output-length arithmetic, so the
 * output matches the Python path sample for sample.
 *
 * python-soxr picks csoxr_split_ch for (N, 1) arrays and csoxr_divide_proc
 * for interleaved (N, C>1); for one channel both feed libsoxr the identical
 * sample stream, so the interleaved form covers both. */
#include <stddef.h>
#include "soxr.h"

/* Upper bound on the output length, exactly as python-soxr computes it. */
size_t forge_soxr_out_len(double in_rate, double out_rate, size_t ilen)
{
  return (size_t)(ilen * out_rate / in_rate + 1);
}

/* Returns NULL on success, else a static error string. *out_done receives
 * the number of output frames written (python-soxr's out_pos). */
const char *forge_soxr_resample_f32(
    double in_rate, double out_rate, unsigned channels,
    const float *x, size_t ilen,
    float *y, size_t olen,
    unsigned long quality, size_t *out_done)
{
  soxr_error_t err = NULL;
  size_t out_pos = 0;
  size_t odone = 0;
  size_t idx;
  double div_d = 48000 * in_rate / out_rate;
  const size_t div_len = (size_t)(div_d > 1000. ? div_d : 1000.);
  const soxr_io_spec_t io_spec = soxr_io_spec(SOXR_FLOAT32_I, SOXR_FLOAT32_I);
  const soxr_quality_spec_t quality_spec = soxr_quality_spec(quality, 0);
  soxr_t soxr = soxr_create(in_rate, out_rate, channels,
                            &err, &io_spec, &quality_spec, NULL);
  *out_done = 0;
  if (err) return err;

  for (idx = 0; idx < ilen; idx += div_len) {
    size_t n = div_len < ilen - idx ? div_len : ilen - idx;
    err = soxr_process(soxr, &x[idx * channels], n, NULL,
                       &y[out_pos * channels], olen - out_pos, &odone);
    out_pos += odone;
  }
  err = soxr_process(soxr, NULL, 0, NULL,
                     &y[out_pos * channels], olen - out_pos, &odone);
  out_pos += odone;
  soxr_delete(soxr);
  *out_done = out_pos;
  return err;
}

unsigned long forge_soxr_hq(void) { return SOXR_HQ; }
unsigned long forge_soxr_vhq(void) { return SOXR_VHQ; }
const char *forge_soxr_version(void) { return soxr_version(); }
