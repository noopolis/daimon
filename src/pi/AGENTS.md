# Pi runtime implementation

This directory owns the Pi harness and native CLI adaptation. Keep public
runtime contracts independent of Pi types. Files stay below 400 lines and
tests live beside their implementations.

Codex permission rendering must preserve the effective path permissions while
removing redundant nested denies that cannot be mounted by its Linux sandbox.
An intervening readable path or workspace root makes a deeper deny necessary.
Verify changes with generated production arguments and real local sandbox
commands; a model call is neither required nor permitted for this check.
