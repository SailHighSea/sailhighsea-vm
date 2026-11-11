# Dot-source this: . .\scripts\env.ps1
# Points every toolchain at D:\apps so nothing is installed on C:.
$env:CARGO_HOME  = 'D:\apps\rust\cargo'
$env:RUSTUP_HOME = 'D:\apps\rust\rustup'
$env:npm_config_cache = 'D:\apps\node\npm-cache'
$env:Path = "D:\apps\node;D:\apps\rust\cargo\bin;$env:Path"
