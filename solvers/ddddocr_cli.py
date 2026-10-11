#!/usr/bin/env python3
"""参考求解器实现 —— 只演示接口契约，不保证对本站验证码的命中率。

契约（LIBSEAT_CAPTCHA_MODE=command）：命令收到图片路径作为参数，stdout 打印 4 位验证码。
把 LIBSEAT_CAPTCHA_CMD 指向你自己的实现即可，其它代码不用改：

    LIBSEAT_CAPTCHA_MODE=command
    LIBSEAT_CAPTCHA_CMD=python3 solvers/ddddocr_cli.py {file}

本站验证码特征（实测）：JPEG 120x40、白底黑字、手写/连笔风格字母数字、带一条横穿干扰线。
如果裸模型命中率不够，考虑先做灰度 + 二值化 + 去横线（按行统计黑像素，黑比例 > 阈值
的行整体提亮），或者上自己的定制模型。
"""

import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: ddddocr_cli.py <image>", file=sys.stderr)
        return 2
    try:
        import ddddocr
    except ImportError:
        print("缺少依赖: uv run --with ddddocr python solvers/ddddocr_cli.py <image>", file=sys.stderr)
        return 3
    with open(sys.argv[1], "rb") as fh:
        image = fh.read()
    ocr = ddddocr.DdddOcr(show_ad=False)
    raw = str(ocr.classification(image)).strip()
    # ddddocr 输出的大小写不稳定（实测把 TWCU 读成 TwCu），而站点校验区分大小写。
    # 已确认的正确答案全是「大写字母 + 数字」，所以统一转大写。
    print(raw.upper())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
