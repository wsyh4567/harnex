use std::{collections::HashMap, sync::Mutex};

pub trait Keyring: Send + Sync {
    fn get(&self, reference: &str) -> keyring::Result<Option<String>>;
    fn set(&self, reference: &str, secret: &str) -> keyring::Result<()>;
    fn delete(&self, reference: &str) -> keyring::Result<()>;
}

pub struct NativeKeyring;

impl Keyring for NativeKeyring {
    fn get(&self, reference: &str) -> keyring::Result<Option<String>> {
        match keyring::Entry::new("ai.harnex.desktop", reference)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set(&self, reference: &str, secret: &str) -> keyring::Result<()> {
        keyring::Entry::new("ai.harnex.desktop", reference)?.set_password(secret)
    }

    fn delete(&self, reference: &str) -> keyring::Result<()> {
        match keyring::Entry::new("ai.harnex.desktop", reference)?.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            result => result,
        }
    }
}

#[derive(Default)]
pub struct MemoryKeyring(Mutex<HashMap<String, String>>);

impl Keyring for MemoryKeyring {
    fn get(&self, reference: &str) -> keyring::Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(reference).cloned())
    }
    fn set(&self, reference: &str, secret: &str) -> keyring::Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(reference.into(), secret.into());
        Ok(())
    }
    fn delete(&self, reference: &str) -> keyring::Result<()> {
        self.0.lock().unwrap().remove(reference);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_crud() {
        let store = MemoryKeyring::default();
        assert_eq!(store.get("ref").unwrap(), None);
        store.set("ref", "test secret").unwrap();
        assert_eq!(store.get("ref").unwrap().as_deref(), Some("test secret"));
        store.delete("ref").unwrap();
        assert_eq!(store.get("ref").unwrap(), None);
    }
}
