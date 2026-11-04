# Weight-only 8-bit Kokoro: every large float weight is stored as int8 with a per-channel scale, and a
# DequantizeLinear node turns it back into float32 when the model runs. The math stays float32, so it runs on
# WebGPU like the full-precision model, at roughly a quarter of the size.
import sys, numpy as np, onnx
from onnx import numpy_helper, helper, TensorProto
src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
print("opsets:", [(o.domain, o.version) for o in m.opset_import])
new_inits, nodes, kept, conv = [], [], 0, 0
for init in g.initializer:
    if init.data_type != TensorProto.FLOAT or np.prod(init.dims) < 4096 or len(init.dims) < 2:
        new_inits.append(init); kept += 1; continue
    w = numpy_helper.to_array(init).astype(np.float32)
    axis = 0 if w.shape[0] > 2 else 1
    red = tuple(i for i in range(w.ndim) if i != axis)
    amax = np.abs(w).max(axis=red)
    scale = np.where(amax > 0, amax / 127.0, 1.0).astype(np.float32)
    shp = [1] * w.ndim; shp[axis] = -1
    q = np.clip(np.round(w / scale.reshape(shp)), -127, 127).astype(np.int8)
    n = init.name
    new_inits += [numpy_helper.from_array(q, n + "_q"), numpy_helper.from_array(scale, n + "_s"), numpy_helper.from_array(np.zeros_like(scale, dtype=np.int8), n + "_z")]
    nodes.append(helper.make_node("DequantizeLinear", [n + "_q", n + "_s", n + "_z"], [n], name=n + "_dq", axis=axis))
    conv += 1
del g.initializer[:]
g.initializer.extend(new_inits)
old = list(g.node); del g.node[:]
g.node.extend(nodes + old)
onnx.save(m, dst)
print(f"quantized {conv} tensors, kept {kept} as float")
