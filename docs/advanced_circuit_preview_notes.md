# Advanced Circuit Preview Findings

The combined `mux4_dff` preview renders a recognisable trapezoidal **MUX 4:1** symbol, a rectangular **D FF** symbol, and a clock-edge triangle at the flip-flop clock pin. Input and output labels are present and the generated SVG confirms that all source, select, data, clock, and output wires are included as orthogonal paths.

At the compact 449×175 preview scale, the fine orthogonal wires are visually subtle relative to the labels and component outlines. The component body, labels, and connection geometry are clear; the production SVG remains vector-based, so rendered Telegram output retains line fidelity at normal viewing scale.

The validation and renderer tests cover accepted MUX/DFF schemas, incorrect pin-count rejection, visible component labels, and the clock marker. Future iterations can add optional near-pin signal annotations and complementary Q-bar outputs where a requested circuit explicitly requires them.
