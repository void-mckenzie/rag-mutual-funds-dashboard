import pymupdf  # PyMuPDF is often imported as fitz
import os
import sys

def decrypt_and_save_pdf(input_pdf_path, output_pdf_path, password):
    """
    Decrypts a password-protected PDF and saves a new unprotected version.

    Args:
        input_pdf_path (str): The file path of the encrypted PDF.
        output_pdf_path (str): The file path to save the decrypted PDF.
        password (str): The password for the encrypted PDF.
    """
    doc = None  # Initialize doc to None
    try:
        # Open the encrypted PDF document
        doc = pymupdf.open(input_pdf_path)

        # Check if the document is password-protected
        if doc.needs_pass:
            # Authenticate with the provided password
            # The authenticate method returns the number of successful authentications
            if doc.authenticate(password):
                print(f"  > Successfully authenticated.")
            else:
                # If authentication fails, print an error and skip this file
                print(f"  > ERROR: Authentication failed for '{os.path.basename(input_pdf_path)}'. Invalid password.")
                return # Stop processing this file
        else:
            print("  > PDF is not encrypted. Saving a copy.")

        # Save a decrypted version of the document
        # To decrypt, we save with encryption set to PDF_ENCRYPT_NONE
        doc.save(output_pdf_path, encryption=pymupdf.PDF_ENCRYPT_NONE)
        print(f"  > Decrypted PDF saved as '{output_pdf_path}'")

    except Exception as e:
        print(f"  > An error occurred while processing '{os.path.basename(input_pdf_path)}': {e}")
    finally:
        # Ensure the document is closed even if errors occur
        if doc:
            doc.close()

# --- Main script logic for batch processing ---

def batch_decrypt_pdfs(input_folder, output_folder, password):
    """
    Finds all PDFs in an input folder, decrypts them, and saves them to an output folder.
    """
    # 1. Create the output directory if it doesn't exist
    print(f"Ensuring output directory exists: '{output_folder}'")
    os.makedirs(output_folder, exist_ok=True)
    
    # 2. Get a list of all files in the input folder
    try:
        files = os.listdir(input_folder)
    except FileNotFoundError:
        print(f"Error: Input folder not found at '{input_folder}'")
        return

    # 3. Loop through all files and process the PDFs
    print(f"\nStarting to process files in '{input_folder}'...")
    pdf_count = 0
    for filename in files:
        # Check if the file is a PDF (case-insensitive)
        if filename.lower().endswith('.pdf'):
            pdf_count += 1
            print(f"\n--- Processing file: {filename} ---")
            
            # Construct the full input and output file paths
            input_path = os.path.join(input_folder, filename)
            output_path = os.path.join(output_folder, filename)
            
            # Call the decryption function
            decrypt_and_save_pdf(input_path, output_path, password)

    if pdf_count == 0:
        print("\nNo PDF files found in the input directory.")
    else:
        print(f"\n\nBatch processing complete. Processed {pdf_count} PDF file(s).")


# --- Configuration ---
# IMPORTANT: Update these paths to match your system.
# Use absolute paths for reliability.

# Use a raw string (r"...") or forward slashes ("/") to avoid issues with backslashes
input_dir = "/home/mukmckenzie/Downloads/ecas_statements"
output_dir = "/home/mukmckenzie/Downloads/ecas_statements_decrypted"
pdf_password = "password"


# Run the batch process
if __name__ == "__main__":
    batch_decrypt_pdfs(input_dir, output_dir, pdf_password)
