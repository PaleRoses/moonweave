"""Render the independently measured scalar comparison as a static figure."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

root = Path(__file__).resolve().parent.parent
release = '.'.join(json.loads((root / 'package.json').read_text())['version'].split('.')[:2])
source = Path(sys.argv[1] if len(sys.argv) > 1 else root / 'validation/filtering-grid.json')
target = Path(sys.argv[2] if len(sys.argv) > 2 else root / f'docs/evidence/{release}/filtering.png')
data = json.loads(source.read_text())
names = [('reference', 'Analytic area reference'), ('linear', 'Linear / point'),
         ('trilinear', 'Trilinear'), ('anisotropic', 'Anisotropic / ≤8 taps')]
fig, axes = plt.subplots(len(data['grids']), 4, figsize=(12.8, 6.8), facecolor='#f7f6f1')
for row, (key, item) in enumerate(data['grids'].items()):
    for column, (name, title) in enumerate(names):
        ax = axes[row, column]
        values = np.array(item['values'][name]).reshape(item['height'], item['width'])
        ax.imshow(values, origin='lower', vmin=0, vmax=1, cmap='cividis', interpolation='nearest')
        ax.set_xticks([])
        ax.set_yticks([])
        for edge in ax.spines.values():
            edge.set_color('#b9b9ad')
        if row == 0:
            ax.set_title(title, fontsize=11, pad=11, color='#25363f')
        if column == 0:
            ax.set_ylabel('4 × 4 texels' if key == 'isotropic' else 'Oblique 16 × 0.5 texels',
                          fontsize=11, labelpad=14, color='#25363f')
fig.suptitle('Image minification: keep the signal, suppress unresolved detail',
             fontsize=16, x=.51, y=.98, color='#25363f')
fig.text(.5, .035,
         'CPU image sampling against the exact box average of the generating function. '
         'Same 0–1 scale in every panel.\n'
         '128 × 128 float32 source; 4,096 samples per footprint. '
         'These two cases measure approximation error, not rendering speed.',
         ha='center', va='bottom', fontsize=9, color='#40505a', linespacing=1.6)
fig.subplots_adjust(left=.075, right=.985, top=.88, bottom=.14, wspace=.09, hspace=.12)
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, dpi=160, facecolor=fig.get_facecolor(), metadata={'Software': 'Moonweave filtering measurement'})
print(target)
