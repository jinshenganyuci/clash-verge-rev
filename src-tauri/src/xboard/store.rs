use super::{Binding, Error, Result};
use crate::utils::dirs;
use std::path::PathBuf;
use tokio::fs;

fn path(name: &str) -> Result<PathBuf> {
    dirs::app_home_dir()
        .map(|dir| dir.join(name))
        .map_err(|_| Error::storage())
}

pub async fn read() -> Result<Option<Binding>> {
    let encrypted = match fs::read(path("xboard-account.dat")?).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::storage()),
    };
    let mut plaintext = unprotect(&encrypted)?;
    let result = serde_json::from_slice(&plaintext).map_err(|_| Error::storage());
    plaintext.fill(0);
    result.map(Some)
}

pub async fn save(binding: &Binding) -> Result<()> {
    let mut plaintext = serde_json::to_vec(binding).map_err(|_| Error::storage())?;
    let encrypted = protect(&plaintext);
    plaintext.fill(0);
    let encrypted = encrypted?;
    let pending = path("xboard-account.dat.pending")?;
    fs::write(&pending, encrypted).await.map_err(|_| Error::storage())?;
    fs::rename(&pending, path("xboard-account.dat")?)
        .await
        .map_err(|_| Error::storage())
}

pub async fn clear() -> Result<()> {
    let mut failed = false;
    for name in ["xboard-account.dat", "xboard-account.dat.pending"] {
        match fs::remove_file(path(name)?).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed = true,
        }
    }
    if failed { Err(Error::storage()) } else { Ok(()) }
}

pub async fn onboarding_complete() -> Result<bool> {
    fs::try_exists(path("xboard-onboarding-complete")?)
        .await
        .map_err(|_| Error::storage())
}

pub async fn complete_onboarding() -> Result<()> {
    fs::write(path("xboard-onboarding-complete")?, b"1")
        .await
        .map_err(|_| Error::storage())
}

pub async fn guide_state() -> Result<Option<String>> {
    match fs::read_to_string(path("xboard-connection-guide")?).await {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Error::storage()),
    }
}

pub async fn save_guide_state(value: &str) -> Result<()> {
    fs::write(path("xboard-connection-guide")?, value)
        .await
        .map_err(|_| Error::storage())
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData},
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| Error::storage())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // Omitting CRYPTPROTECT_LOCAL_MACHINE binds this ciphertext to the current Windows user.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(Error::storage());
    }
    if output.pbData.is_null() {
        return Err(Error::storage());
    }
    let plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(output.pbData.cast());
    }
    Ok(plaintext)
}

fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        crypt(bytes, true)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err(Error::new(
            "XBOARD_PLATFORM_UNSUPPORTED",
            "Account storage is available in the Windows build.",
        ))
    }
}

fn unprotect(bytes: &[u8]) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        crypt(bytes, false)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err(Error::new(
            "XBOARD_PLATFORM_UNSUPPORTED",
            "Account storage is available in the Windows build.",
        ))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_roundtrip_keeps_the_bearer_out_of_persisted_bytes() -> anyhow::Result<()> {
        let plain = b"Bearer example-account-secret";
        let encrypted = protect(plain)?;
        assert!(!encrypted.windows(plain.len()).any(|window| window == plain));
        assert_eq!(unprotect(&encrypted)?, plain);
        assert!(unprotect(b"not dpapi ciphertext").is_err());
        Ok(())
    }
}
