use harnex_l0::tui::app::TuiOptions;
use std::{env, io, path::PathBuf, process};

fn print_help() {
    println!(
        "Harnex TUI v{} — Living Agent Command Deck (Terminal Edition)\n\n\
         USAGE:\n\
           harnex-tui [OPTIONS]\n\n\
         OPTIONS:\n\
           -w, --workspace <DIR>   Workspace directory bound to L0 sandbox (default: current dir)\n\
           -m, --mode <MODE>       Execution mode: craft | plan | ask (default: craft)\n\
               --model <ID>        Override solver model ID\n\
               --provider <ID>     Override provider ID\n\
               --sidecar <PATH>    Explicit path to harnex-sidecar executable\n\
               --data-dir <DIR>    Override Harnex data directory (default: ~/.harnex)\n\
           -h, --help              Print help\n\
           -V, --version           Print version",
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_args() -> Result<TuiOptions, String> {
    let mut workspace = env::current_dir().map_err(|e| format!("current_dir failed: {e}"))?;
    let mut mode = "craft".to_owned();
    let mut model = None;
    let mut provider = None;
    let mut sidecar = None;
    let mut data_dir = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            "-V" | "--version" => {
                println!("harnex-tui {}", env!("CARGO_PKG_VERSION"));
                process::exit(0);
            }
            "-w" | "--workspace" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--workspace requires a directory path".to_owned())?;
                workspace = PathBuf::from(value);
            }
            "-m" | "--mode" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--mode requires craft, plan, or ask".to_owned())?;
                if !matches!(value.as_str(), "craft" | "plan" | "ask") {
                    return Err(format!("invalid mode '{value}' (expected craft, plan, or ask)"));
                }
                mode = value;
            }
            "--model" => {
                model = Some(
                    args.next()
                        .ok_or_else(|| "--model requires a model ID".to_owned())?,
                );
            }
            "--provider" => {
                provider = Some(
                    args.next()
                        .ok_or_else(|| "--provider requires a provider ID".to_owned())?,
                );
            }
            "--sidecar" => {
                sidecar = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--sidecar requires a file path".to_owned())?,
                ));
            }
            "--data-dir" => {
                data_dir = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--data-dir requires a directory path".to_owned())?,
                ));
            }
            other => {
                return Err(format!("unknown argument '{other}' (try --help)"));
            }
        }
    }

    Ok(TuiOptions {
        workspace,
        mode,
        model,
        provider,
        sidecar,
        data_dir,
    })
}

fn main() -> io::Result<()> {
    let options = match parse_args() {
        Ok(opts) => opts,
        Err(msg) => {
            eprintln!("error: {msg}");
            process::exit(2);
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(harnex_l0::tui::run(options))
}
